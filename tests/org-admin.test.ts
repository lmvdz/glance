import { afterEach, beforeEach, expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { resolveDialect } from "../src/db/index.ts";
import { addMemberByEmail, getOrgProfile, listOrgMembers, removeMember, renameOrg, setMemberRole } from "../src/org-admin.ts";

// Minimal in-memory stand-ins for the better-auth-owned tables org-admin reads/writes.
let db: Kysely<Record<string, never>>;
const ORG = "org_test";

beforeEach(async () => {
	db = new Kysely({ dialect: resolveDialect("sqlite::memory:").dialect });
	await sql`create table "organization" ("id" text primary key, "name" text, "slug" text, "metadata" text)`.execute(db);
	await sql`create table "member" ("id" text primary key, "organizationId" text, "userId" text, "role" text, "createdAt" text)`.execute(db);
	await sql`create table "user" ("id" text primary key, "name" text, "email" text, "emailVerified" integer, "createdAt" text, "updatedAt" text)`.execute(db);
	await sql`create table "session" ("userId" text, "activeOrganizationId" text)`.execute(db);
	await sql`insert into "organization" values (${ORG}, 'Acme', ${ORG}, ${JSON.stringify({ workosOrgId: ORG })})`.execute(db);
	await sql`insert into "user" ("id","name","email") values ('u1','Admin One','a1@acme.com'), ('u2','Two','a2@acme.com')`.execute(db);
	await sql`insert into "member" values ('m1',${ORG},'u1','admin','2026-01-01'), ('m2',${ORG},'u2','member','2026-01-02')`.execute(db);
});
afterEach(async () => {
	await db.destroy();
});

test("getOrgProfile reports name, member count, and workos linkage", async () => {
	const p = await getOrgProfile(db, ORG);
	expect(p).toMatchObject({ id: ORG, name: "Acme", memberCount: 2, workosOrgId: ORG, personal: false });
});

test("listOrgMembers joins user identity", async () => {
	const m = await listOrgMembers(db, ORG);
	expect(m.map((x) => `${x.email}:${x.role}`)).toEqual(["a1@acme.com:admin", "a2@acme.com:member"]);
});

test("renameOrg updates the name; rejects empty", async () => {
	expect(await renameOrg(db, ORG, "  Acme Corp  ")).toBe(true);
	expect((await getOrgProfile(db, ORG))?.name).toBe("Acme Corp");
	expect(await renameOrg(db, ORG, "   ")).toBe(false);
});

test("last-admin guard: cannot demote or remove the only admin", async () => {
	expect(await setMemberRole(db, ORG, "u1", "member")).toEqual({ ok: false, error: "can't demote the last admin" });
	expect(await removeMember(db, ORG, "u1")).toEqual({ ok: false, error: "can't remove the last admin" });
});

test("promoting a second admin lifts the guard", async () => {
	expect(await setMemberRole(db, ORG, "u2", "admin")).toEqual({ ok: true });
	// now two admins — demoting u1 is allowed
	expect(await setMemberRole(db, ORG, "u1", "member")).toEqual({ ok: true });
	expect((await listOrgMembers(db, ORG)).find((m) => m.userId === "u1")?.role).toBe("member");
});

test("removeMember drops the row and clears their active org", async () => {
	await sql`insert into "session" values ('u2', ${ORG})`.execute(db);
	expect(await removeMember(db, ORG, "u2")).toEqual({ ok: true });
	expect((await listOrgMembers(db, ORG)).some((m) => m.userId === "u2")).toBe(false);
	const s = await sql<{ activeOrganizationId: string | null }>`select "activeOrganizationId" from "session" where "userId"='u2'`.execute(db);
	expect(s.rows[0]?.activeOrganizationId).toBeNull();
});

test("addMemberByEmail: adds an existing user, creates a new one, rejects dup + bad email", async () => {
	// existing user u2 (a2@acme.com) currently a member — adding them again is a dup
	expect(await addMemberByEmail(db, ORG, "a2@acme.com", "member")).toEqual({ ok: false, error: "already a member" });
	// brand-new email → creates the user + membership
	const r = await addMemberByEmail(db, ORG, "New.Person@acme.com", "admin");
	expect(r).toEqual({ ok: true, created: true });
	const m = await listOrgMembers(db, ORG);
	expect(m.find((x) => x.email === "new.person@acme.com")?.role).toBe("admin");
	// invalid email rejected
	expect(await addMemberByEmail(db, ORG, "not-an-email", "member")).toEqual({ ok: false, error: "enter a valid email" });
});
