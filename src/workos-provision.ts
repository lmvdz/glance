/**
 * WorkOS → better-auth organization reconciliation (JIT org mapping).
 *
 * Maps a signed-in user's WorkOS Organization memberships onto better-auth organizations + members, and
 * sets the session's active organization — so an SSO user lands in the right tenant (with the right RBAC
 * tier + Postgres RLS org_id) instead of an org-less viewer.
 *
 * Design:
 * - The WorkOS Organization id IS the better-auth organization id (a clean 1:1 mapping; no side table).
 * - This is SYSTEM/IdP provisioning, so it writes better-auth's tables directly (via the shared Kysely) and
 *   intentionally bypasses `allowUserToCreateOrganization:false` — that guard blocks a USER self-minting an
 *   org through the API, not the daemon provisioning from a verified WorkOS membership.
 * - Idempotent: upsert org, upsert member, re-point the active org. Safe to run on every login.
 */

import { randomUUID } from "node:crypto";
// Kysely<any>: this module only issues raw `sql` (untyped by design — it writes better-auth-owned tables,
// not the app schema), so the DB generic is irrelevant and `any` keeps it assignable from the app's handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = import("kysely").Kysely<any>;
import { sql } from "kysely";
import {
	createWorkosMembership,
	emailDomain,
	fetchWorkosMemberships,
	findWorkosOrgByDomain,
	mapWorkosRole,
} from "./workos.ts";

export interface ReconcileResult {
	organizationId: string | null;
	role: string | null;
	organizations: { id: string; name: string; role: string }[];
}

/**
 * Reconcile the better-auth user's WorkOS memberships. Returns null when the user has no linked WorkOS
 * account (i.e. they signed in some other way — nothing to do). Otherwise returns the mapped orgs and the
 * chosen active org. `db` is the shared Kysely (works on SQLite + Postgres; identifiers are quoted to match
 * better-auth's camelCase columns).
 */
export async function reconcileWorkosOrgs(db: AnyKysely, betterAuthUserId: string): Promise<ReconcileResult | null> {
	// The WorkOS user id is the linked account's accountId.
	const acct = await sql<{ accountId: string }>`
		select "accountId" from "account" where "userId" = ${betterAuthUserId} and "providerId" = 'workos' limit 1
	`.execute(db);
	const workosUserId = acct.rows[0]?.accountId;
	if (!workosUserId) return null; // not a WorkOS-linked user

	const memberships = await fetchWorkosMemberships(workosUserId);
	const now = new Date().toISOString();
	const organizations: { id: string; name: string; role: string }[] = [];

	for (const m of memberships) {
		const orgId = m.organizationId;
		const name = m.organizationName ?? orgId;
		const role = mapWorkosRole(m.role);

		// Upsert the org (id = WorkOS org id). Keep the name fresh; stash the WorkOS id in metadata for clarity.
		await sql`
			insert into "organization" ("id","name","slug","createdAt","metadata")
			values (${orgId}, ${name}, ${orgId}, ${now}, ${JSON.stringify({ workosOrgId: orgId })})
			on conflict ("id") do update set "name" = excluded."name"
		`.execute(db);

		// Upsert the membership (no natural unique key on (org,user), so select-then-write).
		const existing = await sql<{ id: string }>`
			select "id" from "member" where "organizationId" = ${orgId} and "userId" = ${betterAuthUserId} limit 1
		`.execute(db);
		if (existing.rows[0]) {
			await sql`update "member" set "role" = ${role} where "id" = ${existing.rows[0].id}`.execute(db);
		} else {
			await sql`
				insert into "member" ("id","organizationId","userId","role","createdAt")
				values (${randomUUID()}, ${orgId}, ${betterAuthUserId}, ${role}, ${now})
			`.execute(db);
		}
		organizations.push({ id: orgId, name, role });
	}

	// Point every session for this user at the primary org (first active membership) so RLS org_id + the
	// bridged RBAC tier take effect immediately. No membership ⇒ leave active org untouched.
	const primary = organizations[0] ?? null;
	if (primary) {
		await sql`update "session" set "activeOrganizationId" = ${primary.id} where "userId" = ${betterAuthUserId}`.execute(db);
	}

	return { organizationId: primary?.id ?? null, role: primary?.role ?? null, organizations };
}

/** Set every session for a user to a given active org (RLS org_id + bridged tier take effect). */
async function setActiveOrg(db: AnyKysely, userId: string, orgId: string): Promise<void> {
	await sql`update "session" set "activeOrganizationId" = ${orgId} where "userId" = ${userId}`.execute(db);
}

/** Create (idempotently) a personal workspace owned by the user, and make it active. Personal orgs are
 *  better-auth-native (no WorkOS counterpart — we don't mint a WorkOS org per individual). */
async function createPersonalOrg(db: AnyKysely, userId: string, displayName: string): Promise<string> {
	const orgId = `org_personal_${userId}`;
	const now = new Date().toISOString();
	const name = `${displayName}'s Workspace`;
	await sql`
		insert into "organization" ("id","name","slug","createdAt","metadata")
		values (${orgId}, ${name}, ${orgId}, ${now}, ${JSON.stringify({ personal: true, ownerUserId: userId })})
		on conflict ("id") do nothing
	`.execute(db);
	const existing = await sql<{ id: string }>`select "id" from "member" where "organizationId" = ${orgId} and "userId" = ${userId} limit 1`.execute(db);
	if (!existing.rows[0]) {
		await sql`insert into "member" ("id","organizationId","userId","role","createdAt") values (${randomUUID()}, ${orgId}, ${userId}, 'owner', ${now})`.execute(db);
	}
	await setActiveOrg(db, userId, orgId);
	return orgId;
}

/** Mirror a WorkOS org into better-auth (so admins/UI can reference it) WITHOUT creating a membership. */
async function ensureOrgMirror(db: AnyKysely, orgId: string, name: string): Promise<void> {
	const now = new Date().toISOString();
	await sql`
		insert into "organization" ("id","name","slug","createdAt","metadata")
		values (${orgId}, ${name}, ${orgId}, ${now}, ${JSON.stringify({ workosOrgId: orgId })})
		on conflict ("id") do update set "name" = excluded."name"
	`.execute(db);
}

/** Record a pending join request (idempotent per user+org). */
async function upsertJoinRequest(db: AnyKysely, orgId: string, userId: string, email: string): Promise<void> {
	const existing = await sql<{ id: string }>`
		select "id" from "org_join_requests" where "org_id" = ${orgId} and "user_id" = ${userId} and "status" = 'pending' limit 1
	`.execute(db);
	if (existing.rows[0]) return;
	await sql`
		insert into "org_join_requests" ("id","org_id","user_id","email","status","created_at")
		values (${randomUUID()}, ${orgId}, ${userId}, ${email}, 'pending', ${Date.now()})
	`.execute(db);
}

/** The onboarding outcome for a signed-in user with no active org yet. */
export type OnboardOutcome =
	| { outcome: "mapped"; organizationId: string; role: string } // already a WorkOS member
	| { outcome: "joined"; organizationId: string; role: string } // auto-joined a domain-matched org
	| { outcome: "pending"; organizationId: string; organizationName: string } // join request awaiting approval
	| { outcome: "personal"; organizationId: string } // no company match ⇒ personal workspace
	| { outcome: "none" }; // not a WorkOS-linked user

/**
 * Onboard a signed-in WorkOS user with no active org. Decision tree (org-decides / personal-only-if-no-match):
 *   1. already a WorkOS org member → map it (reconcile).
 *   2. verified email-domain match → org policy: auto → join as member; approval → pending join request.
 *   3. no match → create a personal workspace.
 */
export async function onboardWorkosUser(db: AnyKysely, betterAuthUserId: string): Promise<OnboardOutcome> {
	const acct = await sql<{ accountId: string }>`
		select "accountId" from "account" where "userId" = ${betterAuthUserId} and "providerId" = 'workos' limit 1
	`.execute(db);
	const workosUserId = acct.rows[0]?.accountId;
	if (!workosUserId) return { outcome: "none" };

	const usr = await sql<{ email: string; name: string }>`select "email","name" from "user" where "id" = ${betterAuthUserId} limit 1`.execute(db);
	const email = usr.rows[0]?.email ?? "";
	const displayName = usr.rows[0]?.name || email.split("@")[0] || "User";

	// 1. Existing WorkOS memberships take precedence.
	const reconciled = await reconcileWorkosOrgs(db, betterAuthUserId);
	if (reconciled?.organizationId) return { outcome: "mapped", organizationId: reconciled.organizationId, role: reconciled.role ?? "member" };

	// 2. Verified email-domain match → apply the org's join policy.
	const match = await findWorkosOrgByDomain(emailDomain(email));
	if (match) {
		if (match.joinPolicy === "auto") {
			if (await createWorkosMembership(workosUserId, match.id, "member")) {
				const r2 = await reconcileWorkosOrgs(db, betterAuthUserId);
				if (r2?.organizationId) return { outcome: "joined", organizationId: r2.organizationId, role: r2.role ?? "member" };
			}
			// auto-join failed (API error) — fall through to a request so the user isn't stranded.
		}
		await ensureOrgMirror(db, match.id, match.name);
		await upsertJoinRequest(db, match.id, betterAuthUserId, email);
		return { outcome: "pending", organizationId: match.id, organizationName: match.name };
	}

	// 3. No company match ⇒ personal workspace.
	const personalId = await createPersonalOrg(db, betterAuthUserId, displayName);
	return { outcome: "personal", organizationId: personalId };
}

export interface PendingJoinRequest {
	id: string;
	userId: string;
	email: string;
	createdAt: number;
}

/** Pending join requests for an org (admin view — caller must already be scoped to `orgId`). */
export async function listPendingJoinRequests(db: AnyKysely, orgId: string): Promise<PendingJoinRequest[]> {
	const rows = await sql<{ id: string; user_id: string; email: string; created_at: number }>`
		select "id","user_id","email","created_at" from "org_join_requests" where "org_id" = ${orgId} and "status" = 'pending' order by "created_at" asc
	`.execute(db);
	return rows.rows.map((r) => ({ id: r.id, userId: r.user_id, email: r.email, createdAt: Number(r.created_at) }));
}

/** Approve a pending join request: create the WorkOS membership (source of truth) + reconcile into
 *  better-auth, then mark approved. Scoped to `orgId` so an admin can only approve their own org's requests. */
export async function approveJoinRequest(db: AnyKysely, requestId: string, orgId: string): Promise<boolean> {
	const req = await sql<{ user_id: string }>`
		select "user_id" from "org_join_requests" where "id" = ${requestId} and "org_id" = ${orgId} and "status" = 'pending' limit 1
	`.execute(db);
	const userId = req.rows[0]?.user_id;
	if (!userId) return false;
	const acct = await sql<{ accountId: string }>`select "accountId" from "account" where "userId" = ${userId} and "providerId" = 'workos' limit 1`.execute(db);
	const workosUserId = acct.rows[0]?.accountId;
	if (workosUserId) await createWorkosMembership(workosUserId, orgId, "member");
	await reconcileWorkosOrgs(db, userId);
	await sql`update "org_join_requests" set "status" = 'approved' where "id" = ${requestId}`.execute(db);
	return true;
}

/** Deny a pending join request. */
export async function denyJoinRequest(db: AnyKysely, requestId: string, orgId: string): Promise<boolean> {
	const res = await sql`update "org_join_requests" set "status" = 'denied' where "id" = ${requestId} and "org_id" = ${orgId} and "status" = 'pending'`.execute(db);
	return (res.numAffectedRows ?? 0n) > 0n;
}
