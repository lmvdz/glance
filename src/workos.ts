/**
 * WorkOS enterprise-SSO integration surface.
 *
 * ARCHITECTURE: WorkOS is an upstream identity source only. better-auth stays the owner of
 * users/sessions/organizations + the RLS org_id — WorkOS AuthKit sits in front of every customer's
 * enterprise IdP (SAML/OIDC/social) behind ONE OIDC client, and better-auth mints the local session in
 * its own /api/auth/oauth2/callback/workos handler (see genericOAuth wiring in db/auth.ts). "Integrate
 * once, keep your tenant model."
 *
 * This module is the pure, side-effect-free core: config gating, the AuthKit OIDC discovery URL, and the
 * SCIM (Directory Sync) webhook signature verification + event parsing. It does NOT touch the DB — the
 * provisioning seam (create org / add-remove membership on dsync.* events) is deliberately separate and
 * documented in docs/workos-sso.md, because it can only be finalized against a live WorkOS directory.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface WorkosConfig {
	/** WorkOS Client ID (client_...). Also the path segment in the AuthKit OIDC discovery URL. */
	clientId: string;
	/** WorkOS API key (sk_...). Doubles as the OIDC client secret for the User Management client. */
	apiKey: string;
}

/** WorkOS SSO is wired ONLY when BOTH the client id and api key are present. Absent ⇒ SSO stays off and
 *  the fleet falls back to email+password / direct social. */
export function workosConfig(): WorkosConfig | undefined {
	const clientId = process.env.WORKOS_CLIENT_ID;
	const apiKey = process.env.WORKOS_API_KEY;
	return clientId && apiKey ? { clientId, apiKey } : undefined;
}

/** True when WorkOS enterprise SSO is configured — advertised at /api/auth/mode so the login renders the
 *  "Sign in with SSO" button, and gates the genericOAuth provider. */
export function ssoEnabled(): boolean {
	return !!workosConfig();
}

/** AuthKit's standards-compliant OIDC discovery document. better-auth's genericOAuth reads
 *  authorization/token/userinfo/jwks endpoints from here — we never hardcode them. */
export function workosDiscoveryUrl(clientId: string): string {
	return `https://api.workos.com/user_management/${clientId}/.well-known/openid-configuration`;
}

/** Default replay-window for webhook timestamps (WorkOS recommends ~3–5 min). */
export const WORKOS_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export type SignatureResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a WorkOS webhook signature. Header `WorkOS-Signature: t=<ms>, v1=<hex>`; the signed string is
 * `${timestamp}.${rawBody}` (RAW request bytes — never a re-serialized object), HMAC-SHA256 keyed by the
 * endpoint's webhook secret. Rejects stale timestamps to block replay. Constant-time hex compare.
 */
export function verifyWorkosSignature(args: {
	rawBody: string;
	sigHeader: string | null | undefined;
	secret: string;
	now: number;
	toleranceMs?: number;
}): SignatureResult {
	const { rawBody, sigHeader, secret, now } = args;
	const toleranceMs = args.toleranceMs ?? WORKOS_WEBHOOK_TOLERANCE_MS;
	if (!sigHeader) return { ok: false, reason: "missing signature header" };
	if (!secret) return { ok: false, reason: "no webhook secret configured" };

	let timestamp: string | undefined;
	let provided: string | undefined;
	for (const part of sigHeader.split(",")) {
		const [k, v] = part.split("=");
		if (!k || v === undefined) continue;
		const key = k.trim();
		if (key === "t") timestamp = v.trim();
		else if (key === "v1") provided = v.trim();
	}
	if (!timestamp || !provided) return { ok: false, reason: "malformed signature header" };

	const ts = Number(timestamp);
	if (!Number.isFinite(ts)) return { ok: false, reason: "non-numeric timestamp" };
	if (Math.abs(now - ts) > toleranceMs) return { ok: false, reason: "timestamp outside tolerance" };

	const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
	// timingSafeEqual throws on length mismatch — guard first so a wrong-length sig fails closed, not throws.
	if (provided.length !== expected.length) return { ok: false, reason: "signature mismatch" };
	if (!timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))) {
		return { ok: false, reason: "signature mismatch" };
	}
	return { ok: true };
}

/** The WorkOS event envelope. `data` is the Directory User/Group (or User Management user) object. */
export interface WorkosEvent {
	event: string;
	id: string;
	data: Record<string, unknown>;
	createdAt?: string;
}

/** The Directory Sync (SCIM) events we care about for provisioning/deprovisioning. */
export const DSYNC_EVENTS = [
	"dsync.user.created",
	"dsync.user.updated",
	"dsync.user.deleted",
	"dsync.group.user_added",
	"dsync.group.user_removed",
] as const;

/** Parse a verified webhook body into an event envelope, or null if it isn't the shape we expect.
 *  Only call AFTER verifyWorkosSignature passes. */
export function parseWorkosEvent(rawBody: string): WorkosEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.event !== "string" || typeof obj.id !== "string") return null;
	const data = obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) ? (obj.data as Record<string, unknown>) : {};
	return { event: obj.event, id: obj.id, data, createdAt: typeof obj.created_at === "string" ? obj.created_at : undefined };
}
