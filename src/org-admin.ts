/**
 * Org administration — read/update the caller's active organization (profile, members, roles).
 *
 * Operates directly on better-auth's org/member/user tables via the shared Kysely (like workos-provision),
 * scoped to a single orgId the server has already authorized the caller (admin) for. A last-admin guard
 * prevents an org from being locked out of admin access.
 */

import { randomUUID } from "node:crypto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyKysely = import("kysely").Kysely<any>;
import { sql } from "kysely";

export interface OrgProfile {
	id: string;
	name: string;
	slug: string;
	memberCount: number;
	/** Present when this org mirrors a WorkOS Organization (enterprise/company org). */
	workosOrgId: string | null;
	/** True for a personal workspace (better-auth-native, no WorkOS counterpart). */
	personal: boolean;
}

export interface OrgMember {
	userId: string;
	name: string;
	email: string;
	role: string;
}

function parseMeta(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export async function getOrgProfile(db: AnyKysely, orgId: string): Promise<OrgProfile | null> {
	const rows = await sql<{ id: string; name: string; slug: string; metadata: string | null }>`
		select "id","name","slug","metadata" from "organization" where "id" = ${orgId} limit 1
	`.execute(db);
	const o = rows.rows[0];
	if (!o) return null;
	const cnt = await sql<{ c: number }>`select count(*) as c from "member" where "organizationId" = ${orgId}`.execute(db);
	const meta = parseMeta(o.metadata);
	return {
		id: o.id,
		name: o.name,
		slug: o.slug,
		memberCount: Number(cnt.rows[0]?.c ?? 0),
		workosOrgId: typeof meta.workosOrgId === "string" ? meta.workosOrgId : null,
		personal: meta.personal === true,
	};
}

/** Rename the org. Returns false on an empty/too-long name. */
export async function renameOrg(db: AnyKysely, orgId: string, name: string): Promise<boolean> {
	const n = name.trim();
	if (!n || n.length > 100) return false;
	await sql`update "organization" set "name" = ${n} where "id" = ${orgId}`.execute(db);
	return true;
}

export async function listOrgMembers(db: AnyKysely, orgId: string): Promise<OrgMember[]> {
	const rows = await sql<{ userId: string; name: string; email: string; role: string }>`
		select m."userId" as "userId", u."name" as "name", u."email" as "email", m."role" as "role"
		from "member" m join "user" u on u."id" = m."userId"
		where m."organizationId" = ${orgId}
		order by m."createdAt" asc
	`.execute(db);
	return rows.rows;
}

async function adminCount(db: AnyKysely, orgId: string): Promise<number> {
	const r = await sql<{ c: number }>`
		select count(*) as c from "member" where "organizationId" = ${orgId} and "role" in ('admin','owner')
	`.execute(db);
	return Number(r.rows[0]?.c ?? 0);
}

export interface MutationResult {
	ok: boolean;
	error?: string;
}

/** Change a member's role (admin|member). Refuses to demote the last admin (lockout guard). */
export async function setMemberRole(db: AnyKysely, orgId: string, userId: string, role: string): Promise<MutationResult> {
	const next = role === "admin" ? "admin" : "member";
	const cur = await sql<{ role: string }>`select "role" from "member" where "organizationId" = ${orgId} and "userId" = ${userId} limit 1`.execute(db);
	const curRole = cur.rows[0]?.role;
	if (!curRole) return { ok: false, error: "not a member" };
	const isAdmin = curRole === "admin" || curRole === "owner";
	if (isAdmin && next === "member" && (await adminCount(db, orgId)) <= 1) {
		return { ok: false, error: "can't demote the last admin" };
	}
	await sql`update "member" set "role" = ${next} where "organizationId" = ${orgId} and "userId" = ${userId}`.execute(db);
	return { ok: true };
}

/** Remove a member. Refuses to remove the last admin. Clears their active org if it pointed here. */
export async function removeMember(db: AnyKysely, orgId: string, userId: string): Promise<MutationResult> {
	const cur = await sql<{ role: string }>`select "role" from "member" where "organizationId" = ${orgId} and "userId" = ${userId} limit 1`.execute(db);
	const curRole = cur.rows[0]?.role;
	if (!curRole) return { ok: false, error: "not a member" };
	const isAdmin = curRole === "admin" || curRole === "owner";
	if (isAdmin && (await adminCount(db, orgId)) <= 1) return { ok: false, error: "can't remove the last admin" };
	await sql`delete from "member" where "organizationId" = ${orgId} and "userId" = ${userId}`.execute(db);
	await sql`update "session" set "activeOrganizationId" = null where "userId" = ${userId} and "activeOrganizationId" = ${orgId}`.execute(db);
	return { ok: true };
}

/** Add a member by email (invite). Creates the better-auth user if none exists (they can then sign in via
 *  email/SSO and resolve to the same row). Returns `created` when a new user row was minted. */
export async function addMemberByEmail(db: AnyKysely, orgId: string, email: string, role: string): Promise<MutationResult & { created?: boolean }> {
	const e = email.trim().toLowerCase();
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: "enter a valid email" };
	const next = role === "admin" ? "admin" : "member";
	const found = await sql<{ id: string }>`select "id" from "user" where lower("email") = ${e} limit 1`.execute(db);
	let userId = found.rows[0]?.id;
	let created = false;
	if (!userId) {
		userId = randomUUID();
		const now = new Date().toISOString();
		created = true;
		await sql`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values (${userId}, ${e.split("@")[0]}, ${e}, 0, ${now}, ${now})`.execute(db);
	}
	const member = await sql<{ id: string }>`select "id" from "member" where "organizationId" = ${orgId} and "userId" = ${userId} limit 1`.execute(db);
	if (member.rows[0]) return { ok: false, error: "already a member" };
	await sql`insert into "member" ("id","organizationId","userId","role","createdAt") values (${randomUUID()}, ${orgId}, ${userId}, ${next}, ${new Date().toISOString()})`.execute(db);
	return { ok: true, created };
}
