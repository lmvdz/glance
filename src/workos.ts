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
import { decodeJsonWith, JwtClaimsSchema } from "./schema/external-json.ts";

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
 *  (identity/session are still owned by better-auth). Returns null on any malformed input — including a
 *  payload segment that decodes to valid JSON but isn't an object (the old blind cast waved those through).
 *  @substrate exported for tests only — schema-external-json.test.ts asserts the decode/reject matrix directly. */
export function decodeJwtPayload(jwt: string | undefined | null): Record<string, unknown> | null {
	if (!jwt) return null;
	const parts = jwt.split(".");
	if (parts.length < 2 || !parts[1]) return null;
	return decodeJsonWith(JwtClaimsSchema, Buffer.from(parts[1], "base64url").toString("utf8"));
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

/** Extract the lowercased domain from an email, or null. */
export function emailDomain(email: string | undefined | null): string | null {
	if (!email) return null;
	const at = email.lastIndexOf("@");
	const dom = at > 0 ? email.slice(at + 1).trim().toLowerCase() : "";
	return dom || null;
}

/** Public/consumer email providers never map to a company tenant — those users always get a personal
 *  workspace. Defense-in-depth beyond "only verified domains match" (no company verifies gmail.com). */
export const PUBLIC_EMAIL_DOMAINS = new Set([
	"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
	"yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
	"aol.com", "gmx.com", "mail.com", "zoho.com", "yandex.com", "fastmail.com", "hey.com",
]);

/** Per-org self-serve join policy (stored in the WorkOS org's metadata as `join_policy`). Defaults to
 *  "approval" (safest) when unset. */
export type JoinPolicy = "auto" | "approval";

export interface WorkosOrgMatch {
	id: string;
	name: string;
	joinPolicy: JoinPolicy;
}

/**
 * Find the company WorkOS Organization that owns a VERIFIED email domain. Returns null for public email
 * providers, unverified domains, or no match. Verified-only is the security gate: a domain WorkOS has
 * verified proves the company controls it, so a same-domain user is a legitimate join candidate (still
 * subject to the org's join policy). We re-check `state === "verified"` on the exact domain rather than
 * trusting the `?domains=` filter alone.
 */
export async function findWorkosOrgByDomain(domain: string | null): Promise<WorkosOrgMatch | null> {
	const cfg = workosConfig();
	if (!cfg || !domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
	try {
		const r = await fetch(`https://api.workos.com/organizations?domains=${encodeURIComponent(domain)}&limit=10`, {
			headers: { Authorization: `Bearer ${cfg.apiKey}` },
		});
		if (!r.ok) return null;
		const body = (await r.json()) as { data?: unknown[] };
		for (const o of body.data ?? []) {
			if (!o || typeof o !== "object") continue;
			const org = o as Record<string, unknown>;
			const id = str(org.id);
			if (!id) continue;
			const domains = Array.isArray(org.domains) ? org.domains : [];
			const verified = domains.some((d) => {
				const dd = d as Record<string, unknown>;
				return str(dd?.domain)?.toLowerCase() === domain && dd?.state === "verified";
			});
			if (!verified) continue;
			const meta = org.metadata && typeof org.metadata === "object" ? (org.metadata as Record<string, unknown>) : {};
			const joinPolicy: JoinPolicy = meta.join_policy === "auto" ? "auto" : "approval";
			return { id, name: str(org.name) ?? id, joinPolicy };
		}
		return null;
	} catch {
		return null;
	}
}

/** Create a WorkOS organization membership (used by the auto-join path). Returns true on success. */
export async function createWorkosMembership(workosUserId: string, orgId: string, roleSlug = "member"): Promise<boolean> {
	const cfg = workosConfig();
	if (!cfg) return false;
	try {
		const r = await fetch("https://api.workos.com/user_management/organization_memberships", {
			method: "POST",
			headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ user_id: workosUserId, organization_id: orgId, role_slug: roleSlug }),
		});
		return r.ok;
	} catch {
		return false;
	}
}

/** Read a WorkOS org's domain-join policy from its metadata (default "approval"). */
export async function getWorkosOrgPolicy(orgId: string): Promise<JoinPolicy> {
	const cfg = workosConfig();
	if (!cfg) return "approval";
	try {
		const r = await fetch(`https://api.workos.com/organizations/${orgId}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
		if (!r.ok) return "approval";
		const o = (await r.json()) as { metadata?: Record<string, unknown> };
		return o.metadata?.join_policy === "auto" ? "auto" : "approval";
	} catch {
		return "approval";
	}
}

/** Set a WorkOS org's domain-join policy in its metadata. Sends ONLY `metadata` (merged with current) —
 *  WorkOS's org update treats omitted fields as unchanged, so name/domains are preserved. */
export async function setWorkosOrgPolicy(orgId: string, policy: JoinPolicy): Promise<boolean> {
	const cfg = workosConfig();
	if (!cfg) return false;
	try {
		const g = await fetch(`https://api.workos.com/organizations/${orgId}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
		const cur = g.ok ? (((await g.json()) as { metadata?: Record<string, unknown> }).metadata ?? {}) : {};
		const r = await fetch(`https://api.workos.com/organizations/${orgId}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ metadata: { ...cur, join_policy: policy === "auto" ? "auto" : "approval" } }),
		});
		return r.ok;
	} catch {
		return false;
	}
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
