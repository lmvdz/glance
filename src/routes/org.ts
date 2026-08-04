/**
 * Org / auth-admin routes (plans/deepen-modules/05, slice 3) — moved verbatim from server.ts's
 * handle() chain. This lane is the seam's third context shape: it runs BEFORE manager/actor
 * resolution, so its context is the SESSION tier — `auth`/`db`/`session`/`role` plus the one
 * server-instance rate limiter the voice-key PUT needs — and it extends `MatchContext`, not
 * `RouteContext` (there is no manager to pass, and resolving one early to satisfy a type would
 * change behaviour).
 *
 * Tenancy rule carried from every handler below (the PR #152 lesson): org id comes from
 * `session.session.activeOrganizationId` ONLY — never a request parameter names the org.
 * Admin-tier routes re-check `roleAtLeast(role, "admin")` inline even where authz.ts already
 * pins them — belt and suspenders, a future authz.ts regression still fails closed here.
 *
 * NOT in this lane, deliberately: `/api/me` and `/api/auth/check` (no method discriminator —
 * they answer any verb, which `Route.method` cannot express verbatim) and `/api/workos/sync`
 * (runs BEFORE the tier gate on purpose — a freshly-signed-in SSO user is org-less (⇒ viewer)
 * and must be able to onboard themselves; this lane dispatches after the gate).
 */
import { roleAtLeast } from "../auth.ts";
import { deleteOrgSecret, getOrgSecret, putOrgSecret, setOrgSecretEnabled } from "../dal/store.ts";
import type { DbHandle } from "../db/index.ts";
import { addMemberByEmail, getOrgProfile, listOrgMembers, removeMember, renameOrg, setMemberRole } from "../org-admin.ts";
import {
	decodeBody,
	decodeBodyOrEmpty,
	JoinRequestDecideBodySchema,
	OrgJoinPolicyBodySchema,
	OrgMemberInviteBodySchema,
	OrgMemberRoleBodySchema,
	OrgPatchBodySchema,
	OrgVoiceEnabledBodySchema,
	OrgVoiceKeyBodySchema,
} from "../schema/http-body.ts";
import type { AuthInstance, AuthSession } from "../server.ts";
import type { Role } from "../types.ts";
import { isKnownVoiceProvider, verifyVoiceProviderKey } from "../voice-token.ts";
import { approveJoinRequest, denyJoinRequest, listPendingJoinRequests } from "../workos-provision.ts";
import { getWorkosOrgPolicy, setWorkosOrgPolicy } from "../workos.ts";
import { dispatchRoutes, type MatchContext, type Route } from "./table.ts";
import { Result } from "effect";

export interface OrgRouteContext extends MatchContext {
	/** Truthy ⇔ DB mode — every route here answers "unavailable" without it (file mode has no orgs). */
	auth: AuthInstance | undefined;
	db: DbHandle | undefined;
	/** The request's resolved better-auth session — the ONLY source of the org id. */
	session: AuthSession | null;
	/** The SAME resolved role the request's authz gate already used, not re-derived. */
	role: Role;
	/** Per-actor rate cap for the voice-key PUT (server-instance state, passed as a thunk). */
	voiceKeyPutRateAllowed: (actorId: string) => boolean;
}

const ORG_ROUTES: readonly Route<OrgRouteContext>[] = [
	// Admin: pending join requests for the caller's active org (domain-match "require approval" policy).
	// Exposes member emails ⇒ admin-only, scoped to the caller's own active org.
	{
		method: "GET",
		pattern: "/api/workos/join-requests",
		handler: async ({ auth, db, session, role }) => {
			if (!auth || !db || session === null || !roleAtLeast(role, "admin")) return Response.json([]);
			const orgId = session.session.activeOrganizationId;
			return Response.json(orgId ? await listPendingJoinRequests(db.db, orgId) : []);
		},
	},
	{
		method: "POST",
		pattern: "/api/workos/join-requests/decide",
		handler: async ({ auth, db, session, role, req }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const raw: unknown = await req.json().catch(() => null);
			const decoded = decodeBody(JoinRequestDecideBodySchema, raw);
			if (Result.isFailure(decoded)) return new Response("missing id", { status: 400 });
			const body = decoded.success;
			const ok = body.action === "deny" ? await denyJoinRequest(db.db, body.id, orgId) : await approveJoinRequest(db.db, body.id, orgId);
			return Response.json({ ok });
		},
	},
	// Org settings. Profile is visible to any member of the active org; member management is admin-only,
	// scoped to the caller's own active org.
	{
		method: "GET",
		pattern: "/api/org",
		handler: async ({ auth, db, session }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			const orgId = session.session.activeOrganizationId;
			return Response.json(orgId ? await getOrgProfile(db.db, orgId) : null);
		},
	},
	{
		method: "PATCH",
		pattern: "/api/org",
		handler: async ({ auth, db, session, role, req }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const body = decodeBodyOrEmpty(OrgPatchBodySchema, await req.json().catch(() => null));
			const ok = await renameOrg(db.db, orgId, typeof body.name === "string" ? body.name : "");
			return Response.json({ ok });
		},
	},
	{
		method: "GET",
		pattern: "/api/org/members",
		handler: async ({ auth, db, session, role }) => {
			if (!auth || !db || session === null || !roleAtLeast(role, "admin")) return Response.json([]);
			const orgId = session.session.activeOrganizationId;
			return Response.json(orgId ? await listOrgMembers(db.db, orgId) : []);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/org\/members\/(?:role|remove)$/,
		handler: async ({ auth, db, session, role, req, url }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const decoded = decodeBody(OrgMemberRoleBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.userId) return new Response("missing userId", { status: 400 });
			const { userId, role: targetRole } = decoded.success;
			if (userId === session.user.id) return Response.json({ ok: false, error: "you can't change your own membership here" });
			const result =
				url.pathname === "/api/org/members/role"
					? await setMemberRole(db.db, orgId, userId, typeof targetRole === "string" ? targetRole : "")
					: await removeMember(db.db, orgId, userId);
			return Response.json(result);
		},
	},
	{
		method: "POST",
		pattern: "/api/org/members/invite",
		handler: async ({ auth, db, session, role, req }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const decoded = decodeBody(OrgMemberInviteBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.email) return new Response("missing email", { status: 400 });
			const { email, role: inviteRole } = decoded.success;
			return Response.json(await addMemberByEmail(db.db, orgId, email, typeof inviteRole === "string" ? inviteRole : "member"));
		},
	},
	// Domain-join policy (WorkOS orgs only) — read/set the org's auto|approval policy in WorkOS metadata.
	{
		method: "GET",
		pattern: "/api/org/join-policy",
		handler: async ({ auth, db, session, role }) => {
			if (!auth || !db || session === null || !roleAtLeast(role, "admin")) return Response.json({ policy: null });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return Response.json({ policy: null });
			const profile = await getOrgProfile(db.db, orgId);
			if (!profile?.workosOrgId) return Response.json({ policy: null }); // not a WorkOS org
			return Response.json({ policy: await getWorkosOrgPolicy(profile.workosOrgId) });
		},
	},
	{
		method: "POST",
		pattern: "/api/org/join-policy",
		handler: async ({ auth, db, session, role, req }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const profile = await getOrgProfile(db.db, orgId);
			if (!profile?.workosOrgId) return Response.json({ ok: false, error: "not a WorkOS-backed organization" });
			const body = decodeBodyOrEmpty(OrgJoinPolicyBodySchema, await req.json().catch(() => null));
			const policy = body.policy === "auto" ? "auto" : "approval";
			return Response.json({ ok: await setWorkosOrgPolicy(profile.workosOrgId, policy), policy });
		},
	},
	// Org voice-key admin surface (plans/voice-db-mode/05-admin-endpoints.md): set / verify /
	// disable / remove the org's own BYO voice provider key. Org id comes from the SESSION only,
	// never a request parameter (the PR #152 lesson: one org's admin registering another org's
	// worktree via a body-supplied id) — every handler below reads
	// `session.session.activeOrganizationId` and nothing else names the org. All four routes are
	// admin-tier, pinned in `authz.ts` (stricter than the rest of `/api/org`, whose profile GET is
	// viewer-readable) AND re-checked here inline, mirroring the `renameOrg` idiom every other
	// admin mutation in this lane already follows — belt and suspenders, not redundant with the
	// authz.ts gate: a future authz.ts regression still fails closed at the handler.
	{
		method: "GET",
		pattern: "/api/org/voice",
		handler: async ({ auth, db, session, role, url }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			// `provider` query param, defaulting to "openai" — mirrors PUT/POST's body field so the
			// four voice-key admin routes can't drift apart the moment a second provider is
			// registered (today the registry has exactly one, so this is a no-op default). Session-
			// org-scoped like every other field here; never trusts anything beyond `isKnownVoiceProvider`.
			const getProviderId = url.searchParams.get("provider") || "openai";
			if (!isKnownVoiceProvider(getProviderId)) return new Response("unknown voice provider", { status: 400 });
			// Status only, never the key itself (DESIGN.md admin-surface row) — `getOrgSecret`'s
			// `plaintext` field is read here but never placed on the response.
			const secret = await getOrgSecret({ db: db.db, type: db.type }, orgId, getProviderId);
			if (!secret) return Response.json({ configured: false });
			return Response.json({ configured: true, last4: secret.last4, enabled: secret.enabled, updatedAt: secret.updatedAt, updatedBy: secret.updatedBy });
		},
	},
	{
		method: "PUT",
		pattern: "/api/org/voice-key",
		handler: async ({ auth, db, session, role, req, voiceKeyPutRateAllowed }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			// `db:<userId>`, never role-derived — same actor-tagging convention as the mint audit
			// write (voiceScope's `actor.id`), computed locally: this lane runs before handle()'s
			// fleet-manager `actor`/`manager` resolution, so no resolved actor exists yet.
			const actorId = `db:${session.user.id}`;
			if (!voiceKeyPutRateAllowed(actorId)) return new Response("rate limited", { status: 429 });
			const decoded = decodeBody(OrgVoiceKeyBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded) || !decoded.success.apiKey) return new Response("apiKey is required", { status: 400 });
			const { apiKey, provider: providerRaw } = decoded.success;
			const providerId = typeof providerRaw === "string" && providerRaw ? providerRaw : "openai";
			if (!isKnownVoiceProvider(providerId)) return new Response("unknown voice provider", { status: 400 });
			// Verify BEFORE persist (DESIGN.md "Key verification on save"): a free GET against the
			// provider's own auth-check endpoint, NEVER the mint endpoint (that issues a real, billable
			// credential). A rejected key writes NOTHING — no row, no last4, no partial state.
			if (!(await verifyVoiceProviderKey(providerId, apiKey))) return new Response("key rejected by provider", { status: 400 });
			const summary = await putOrgSecret({ db: db.db, type: db.type }, orgId, providerId, apiKey, actorId);
			// `undefined` only when no master key is configured server-side (secrets.ts: a write that
			// can't be encrypted persists nothing) — an honest 501, not a silent no-op 200.
			if (!summary) return new Response("voice key storage unavailable", { status: 501 });
			return Response.json({ configured: true, last4: summary.last4, enabled: summary.enabled, updatedAt: summary.updatedAt, updatedBy: summary.updatedBy });
		},
	},
	{
		method: "DELETE",
		pattern: "/api/org/voice-key",
		handler: async ({ auth, db, session, role, url }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			// `provider` query param, same default + validation as GET above — the row PUT stored under
			// a non-default provider must be reachable to delete, not stranded.
			const deleteProviderId = url.searchParams.get("provider") || "openai";
			if (!isKnownVoiceProvider(deleteProviderId)) return new Response("unknown voice provider", { status: 400 });
			await deleteOrgSecret({ db: db.db, type: db.type }, orgId, deleteProviderId);
			return Response.json({ configured: false });
		},
	},
	{
		method: "POST",
		pattern: "/api/org/voice/enabled",
		handler: async ({ auth, db, session, role, req }) => {
			if (!auth || !db || session === null) return new Response("unavailable", { status: 400 });
			if (!roleAtLeast(role, "admin")) return new Response("forbidden", { status: 403 });
			const orgId = session.session.activeOrganizationId;
			if (!orgId) return new Response("no active org", { status: 400 });
			const actorId = `db:${session.user.id}`;
			const decoded = decodeBody(OrgVoiceEnabledBodySchema, await req.json().catch(() => null));
			if (Result.isFailure(decoded)) return new Response("enabled boolean required", { status: 400 });
			const { enabled, provider: providerRaw } = decoded.success;
			const providerId = typeof providerRaw === "string" && providerRaw ? providerRaw : "openai";
			if (!isKnownVoiceProvider(providerId)) return new Response("unknown voice provider", { status: 400 });
			// Synchronous kill switch (DESIGN.md "Kill switch" row): flips a bit without deleting the
			// stored key — instant, reversible, no re-paste. A no-op (not an error) when the org has no
			// row for this provider yet, matching `setOrgSecretEnabled`'s own doc comment.
			await setOrgSecretEnabled({ db: db.db, type: db.type }, orgId, providerId, enabled, actorId);
			const secret = await getOrgSecret({ db: db.db, type: db.type }, orgId, providerId);
			return Response.json(secret ? { configured: true, last4: secret.last4, enabled: secret.enabled, updatedAt: secret.updatedAt, updatedBy: secret.updatedBy } : { configured: false });
		},
	},
];

/** The org lane's route adapter — session-tier context passed explicitly, same fall-through
 *  contract as every other lane (`undefined` = not ours, the caller's chain continues). */
export async function handleOrgRoutes(url: URL, req: Request, ctx: Omit<OrgRouteContext, "url" | "req">): Promise<Response | undefined> {
	return dispatchRoutes(ORG_ROUTES, { url, req, ...ctx });
}
