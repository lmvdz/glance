import { afterEach, beforeEach, expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { resolveDialect } from "../src/db/index.ts";
import { provisionScimEvent } from "../src/workos-provision.ts";
import type { WorkosEvent } from "../src/workos.ts";

let db: Kysely<Record<string, never>>;
const ORG = "org_scim";

beforeEach(async () => {
	db = new Kysely({ dialect: resolveDialect("sqlite::memory:").dialect });
	await sql`create table "organization" ("id" text primary key, "name" text, "slug" text, "createdAt" text, "metadata" text)`.execute(db);
	await sql`create table "member" ("id" text primary key, "organizationId" text, "userId" text, "role" text, "createdAt" text)`.execute(db);
	await sql`create table "user" ("id" text primary key, "name" text, "email" text, "emailVerified" integer, "createdAt" text, "updatedAt" text)`.execute(db);
	await sql`create table "session" ("userId" text, "activeOrganizationId" text)`.execute(db);
});
afterEach(async () => {
	await db.destroy();
});

const ev = (event: string, data: Record<string, unknown>): WorkosEvent => ({ event, id: "evt_1", data });
const dirUser = (email: string, extra: Record<string, unknown> = {}) => ({
	organization_id: ORG,
	organization_name: "Acme",
	emails: [{ primary: true, value: email }],
	first_name: "Ada",
	last_name: "Lovelace",
	...extra,
});

async function members() {
	return (await sql<{ email: string; role: string }>`select u."email" as email, m."role" as role from "member" m join "user" u on u."id"=m."userId" where m."organizationId"=${ORG}`.execute(db)).rows;
}

test("dsync.user.created provisions the org, the user, and the membership", async () => {
	const r = await provisionScimEvent(db, ev("dsync.user.created", dirUser("ada@acme.com")));
	expect(r).toEqual({ handled: true, action: "provisioned" });
	// org mirrored
	const org = await sql<{ name: string }>`select "name" from "organization" where "id"=${ORG}`.execute(db);
	expect(org.rows[0]?.name).toBe("Acme");
	// user + member
	expect(await members()).toEqual([{ email: "ada@acme.com", role: "member" }]);
});

test("re-provisioning the same user is idempotent (no duplicate user or membership)", async () => {
	await provisionScimEvent(db, ev("dsync.user.created", dirUser("ada@acme.com")));
	await provisionScimEvent(db, ev("dsync.user.updated", dirUser("ada@acme.com")));
	expect((await sql`select count(*) as c from "user"`.execute(db)).rows).toEqual([{ c: 1 }]);
	expect(await members()).toHaveLength(1);
});

test("email match is case-insensitive (login vs directory casing resolve to one user)", async () => {
	await provisionScimEvent(db, ev("dsync.user.created", dirUser("Ada@Acme.com")));
	await provisionScimEvent(db, ev("dsync.user.updated", dirUser("ada@acme.com")));
	expect((await sql`select count(*) as c from "user"`.execute(db)).rows).toEqual([{ c: 1 }]);
});

test("dsync.user.deleted removes the membership and clears their active org", async () => {
	await provisionScimEvent(db, ev("dsync.user.created", dirUser("ada@acme.com")));
	const uid = (await sql<{ id: string }>`select "id" from "user" where "email"='ada@acme.com'`.execute(db)).rows[0].id;
	await sql`insert into "session" values (${uid}, ${ORG})`.execute(db);

	const r = await provisionScimEvent(db, ev("dsync.user.deleted", dirUser("ada@acme.com")));
	expect(r).toEqual({ handled: true, action: "deprovisioned" });
	expect(await members()).toHaveLength(0);
	const s = await sql<{ activeOrganizationId: string | null }>`select "activeOrganizationId" from "session" where "userId"=${uid}`.execute(db);
	expect(s.rows[0]?.activeOrganizationId).toBeNull();
});

test("events without an org id or email are not handled", async () => {
	expect(await provisionScimEvent(db, ev("dsync.user.created", { organization_id: ORG, emails: [] }))).toEqual({ handled: false });
	expect(await provisionScimEvent(db, ev("dsync.user.created", { emails: [{ primary: true, value: "x@y.com" }] }))).toEqual({ handled: false });
	expect(await provisionScimEvent(db, ev("dsync.group.created", dirUser("ada@acme.com")))).toEqual({ handled: false });
});
