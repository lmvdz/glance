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

/** Decode a JWT's payload WITHOUT verifying its signature. Safe here: the token was just handed to us by
 *  WorkOS over TLS in the code→token exchange, and we only read non-authoritative profile claims from it
 *  (identity/session are still owned by better-auth). Returns null on any malformed input. */
export function decodeJwtPayload(jwt: string | undefined | null): Record<string, unknown> | null {
	if (!jwt) return null;
	const parts = jwt.split(".");
	if (parts.length < 2 || !parts[1]) return null;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Normalized profile from a WorkOS sign-in, plus the WorkOS org/role for later JIT org mapping. */
export interface WorkosProfile {
	id: string;
	email: string;
	emailVerified: boolean;
	name: string;
	image?: string;
	/** WorkOS Organization id from the token claims (present when the login was org-scoped). */
	workosOrgId?: string;
	/** WorkOS org-membership role from the token claims. */
	workosRole?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Resolve the sign-in profile from WorkOS tokens — the custom getUserInfo for our genericOAuth provider.
 *
 * WHY custom: WorkOS's OIDC discovery exposes NO userinfo endpoint, and its access-token JWT omits email,
 * so better-auth's default (decode id_token OR call userinfo) yields nothing → "user_info_is_missing". We
 * decode the token for sub/org_id/role, then fetch email/name from the WorkOS User Management API. Returns
 * null (better-auth then surfaces user_info_is_missing) only if we can't get a subject + email.
 */
export async function workosUserInfo(tokens: { idToken?: string | null; accessToken?: string | null }): Promise<WorkosProfile | null> {
	const cfg = workosConfig();
	const claims = decodeJwtPayload(tokens.idToken) ?? decodeJwtPayload(tokens.accessToken);
	const sub = str(claims?.sub);
	const orgId = str(claims?.org_id) ?? str(claims?.organization_id);
	const role = str(claims?.role);
	let email = str(claims?.email);
	let name = str(claims?.name);
	let image = str(claims?.picture);
	let emailVerified = claims?.email_verified === true;

	// WorkOS access-token JWTs carry sub/org/role but not email/name — fetch those from the User API.
	if (sub && (!email || !name) && cfg) {
		try {
			const r = await fetch(`https://api.workos.com/user_management/users/${sub}`, {
				headers: { Authorization: `Bearer ${cfg.apiKey}` },
			});
			if (r.ok) {
				const u = (await r.json()) as Record<string, unknown>;
				email = str(u.email) ?? email;
				const full = [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ").trim();
				if (full) name = full;
				image = str(u.profile_picture_url) ?? image;
				if (typeof u.email_verified === "boolean") emailVerified = u.email_verified;
			}
		} catch {
			// Network failure ⇒ fall through; null return below yields a clean user_info_is_missing.
		}
	}

	// Diagnostic (no secrets — presence flags + non-sensitive org/role + the claim key set) to characterize
	// the real WorkOS token shape against a live tenant. Safe to remove once org mapping is finalized.
	console.log(`[workos] user info: sub=${sub ? "y" : "n"} email=${email ? "y" : "n"} org_id=${orgId ?? "none"} role=${role ?? "none"} claimKeys=${claims ? Object.keys(claims).join("|") : "none"}`);

	if (!sub || !email) return null;
	return { id: sub, email, emailVerified, name: name || email, image, workosOrgId: orgId, workosRole: role };
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

/** A user's membership in a WorkOS Organization (from the org-memberships API). */
export interface WorkosMembership {
	organizationId: string;
	organizationName?: string;
	/** WorkOS role slug (e.g. "admin", "member"). */
	role?: string;
	status?: string;
}

/** Fetch a WorkOS user's ACTIVE organization memberships. Returns [] when SSO is unconfigured or the API
 *  errors (caller treats that as "no orgs" — a safe, non-mutating default). */
export async function fetchWorkosMemberships(workosUserId: string): Promise<WorkosMembership[]> {
	const cfg = workosConfig();
	if (!cfg) return [];
	const url = `https://api.workos.com/user_management/organization_memberships?user_id=${encodeURIComponent(workosUserId)}&statuses=active&limit=100`;
	try {
		const r = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
		if (!r.ok) return [];
		const body = (await r.json()) as { data?: unknown[] };
		const out: WorkosMembership[] = [];
		for (const m of body.data ?? []) {
			if (!m || typeof m !== "object") continue;
			const o = m as Record<string, unknown>;
			const orgId = str(o.organization_id);
			if (!orgId) continue;
			const roleObj = o.role && typeof o.role === "object" ? (o.role as Record<string, unknown>) : undefined;
			out.push({
				organizationId: orgId,
				organizationName: str(o.organization_name),
				role: str(roleObj?.slug),
				status: str(o.status),
			});
		}
		return out;
	} catch {
		return [];
	}
}

/** Map a WorkOS role slug → a better-auth organization role. admin/owner ⇒ admin (→ RBAC admin tier via
 *  bridgeRole); everything else ⇒ member (→ operator tier). */
export function mapWorkosRole(slug: string | undefined): "admin" | "member" {
	return slug === "admin" || slug === "owner" ? "admin" : "member";
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
