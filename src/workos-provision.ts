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
import { fetchWorkosMemberships, mapWorkosRole } from "./workos.ts";

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
