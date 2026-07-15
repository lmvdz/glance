/**
 * `bridgeRole` (server.ts) org-binding regression — cross-lineage audit finding (codex, confirmed):
 * `bridgeRole` received `activeOrgId` (the resource org every `/api/org/voice*` route re-reads from
 * `session.session.activeOrganizationId`) but only used it for the null-guard — the actual role
 * lookup called `this.auth.api.getActiveMemberRole({ headers: req.headers })` WITHOUT
 * `query: { organizationId: activeOrgId }`, even though the `AuthInstance` type has supported that
 * param since the interface was declared. Without it, better-auth re-resolves the role against
 * whatever org is active AT CALL TIME — its own fresh lookup — not the org this function was handed.
 *
 * The exploit shape: a user who is a plain MEMBER of org A and an ADMIN of org B holds a session
 * whose `getSession()` snapshot names org A as active (so every route's own `orgId` re-read resolves
 * to A — the resource these routes act on). If that user's TRUE active org has since flipped to B
 * (a race with a concurrent "switch active org" request — a real, user-triggered action, not a
 * theoretical clock skew), the unqualified `getActiveMemberRole` call resolves the CURRENT active
 * org's role: admin of B. The old code would then grant admin tier and let the handler write org A's
 * voice key — a cross-tenant WRITE, using an admin role earned in a DIFFERENT org than the one being
 * mutated. The fix binds the role lookup to the SAME org id the resource read uses
 * (`query: { organizationId: activeOrgId }`), so role and resource can never straddle two orgs.
 *
 * This file pins that binding directly, with an `AuthInstance` stub that — unlike
 * tests/voice-org-admin.test.ts's `dbAuthStubFor` (one role per user, `query` ignored) — models a
 * user with DIFFERENT roles in different orgs, and a `getActiveMemberRole` that only returns the
 * correct (queried) role when `query.organizationId` is actually passed; an unqualified call
 * resolves whatever the "currently live" active org happens to be, which the fixture deliberately
 * sets to the DIFFERENT org — modeling the race, not assuming it away.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOrgSecret } from "../src/dal/store.ts";
import { openDatabase, type DbHandle } from "../src/db/index.ts";
import { initMasterKey } from "../src/secrets.ts";
import { SquadServer, type AuthInstance, type SquadServerOptions } from "../src/server.ts";

const OPENAI_VERIFY_URL = "https://api.openai.com/v1/models";
const realFetch = globalThis.fetch;

// Fixed 32-byte master key, same convention as the other voice-* test files.
const KEY_HEX = "b1a2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e9f0";

const SAVED_ENV: Record<string, string | undefined> = {
	DATABASE_URL: process.env.DATABASE_URL,
};
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	globalThis.fetch = realFetch;
	for (const [name, value] of Object.entries(SAVED_ENV)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function mockOpenAiVerifyAlwaysOk(): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url !== OPENAI_VERIFY_URL) return realFetch(input as never, init);
		return new Response(null, { status: 200 });
	}) as typeof fetch;
}

type Tier = "member" | "admin" | "owner";

interface RaceUser {
	id: string;
	/** The org `getSession()` reports active — the SAME value every `/api/org/voice*` route re-reads
	 *  as `session.session.activeOrganizationId` and uses as the resource it acts on. */
	sessionOrgId: string;
	/** Role per org, consulted ONLY when `getActiveMemberRole` is called WITH
	 *  `query.organizationId` — the fixed, correct path. */
	rolesByOrg: Record<string, Tier>;
	/** Role returned when `getActiveMemberRole` is called WITHOUT a query — models "whatever org is
	 *  actually live right now", which a real better-auth instance resolves independently of the
	 *  `getSession()` snapshot already taken. Deliberately set to a DIFFERENT org's role than
	 *  `sessionOrgId` names, to model the race the vulnerability lived in rather than assume it away. */
	liveRoleNoQuery: Tier;
}

/** Cookie-keyed auth stub keying off `session=<key>` (same convention as the other voice-* test
 *  files' `dbAuthStubFor`), but — unlike those — `getActiveMemberRole` genuinely branches on whether
 *  `query.organizationId` was passed, so this file can tell the fixed code path (queries the SAME
 *  org the resource uses) apart from the vulnerable one (queries nothing, gets whatever's "live"). */
function raceAuthStubFor(users: Record<string, RaceUser>): AuthInstance {
	const lookup = (headers: Headers): RaceUser | undefined => {
		const cookie = headers.get("cookie") ?? "";
		const match = /(?:^|;\s*)session=([^;]+)/.exec(cookie);
		return match ? users[match[1]] : undefined;
	};
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }: { headers: Headers }) => {
				const user = lookup(headers);
				if (!user) return null;
				return { user: { id: user.id, name: user.id, email: `${user.id}@example.test` }, session: { activeOrganizationId: user.sessionOrgId } };
			},
			getActiveMemberRole: async ({ headers, query }: { headers: Headers; query?: { organizationId?: string } }) => {
				const user = lookup(headers);
				if (!user) return { role: "member" };
				if (query?.organizationId) return { role: user.rolesByOrg[query.organizationId] ?? "member" };
				return { role: user.liveRoleNoQuery };
			},
		},
	} as unknown as AuthInstance;
}

async function startServer(orgIds: string[], users: Record<string, RaceUser>, extraOpts: Partial<SquadServerOptions> = {}): Promise<{ url: string; handle: DbHandle }> {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-role-binding-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const handle = await openDatabase();
	if (!handle) throw new Error("openDatabase returned null in DB mode");
	for (const id of orgIds) {
		await handle.db.insertInto("organization").values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() }).execute();
	}
	const server = new SquadServer(undefined, { port: 0, auth: raceAuthStubFor(users), db: handle, ...extraOpts });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await handle.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { url, handle };
}

function cookie(key: string): Record<string, string> {
	return { cookie: `session=${key}` };
}

test("bridgeRole: member-of-A/admin-of-B, session active=A, live-active(no query)=B — PUT /api/org/voice-key on the session's own org (A) gets 403, not 200; org A's key is left untouched", async () => {
	const attacker: RaceUser = {
		id: "attacker",
		sessionOrgId: "orgA", // the resource every route below acts on
		rolesByOrg: { orgA: "member", orgB: "admin" },
		liveRoleNoQuery: "admin", // simulates the active-org flip to B between getSession and the role check
	};
	const { url, handle } = await startServer(["orgA", "orgB"], { attacker });
	mockOpenAiVerifyAlwaysOk();

	// Without the fix, `getActiveMemberRole({headers})` (no query) resolves `liveRoleNoQuery` = admin,
	// granting admin tier — which the vulnerable code would then use to write org A's key, even though
	// this user is only a MEMBER of org A. The fix queries org A explicitly and must see "member".
	const put = await fetch(`${url}/api/org/voice-key`, {
		method: "PUT",
		headers: { ...cookie("attacker"), "content-type": "application/json" },
		body: JSON.stringify({ apiKey: "sk-cross-tenant-attempt" }),
	});
	expect(put.status).toBe(403);

	const ctx = { db: handle.db, type: handle.type };
	expect(await getOrgSecret(ctx, "orgA", "openai")).toBeUndefined();

	// The other three admin-gated voice routes must refuse identically — same `bridgeRole` call.
	expect((await fetch(`${url}/api/org/voice`, { headers: cookie("attacker") })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "DELETE", headers: cookie("attacker") })).status).toBe(403);
	expect(
		(
			await fetch(`${url}/api/org/voice/enabled`, {
				method: "POST",
				headers: { ...cookie("attacker"), "content-type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			})
		).status,
	).toBe(403);
});

test("bridgeRole: the SAME user's org B session (active=B, live-active(no query)=B, no race) DOES get admin tier there — the fix only rejects the mismatched-org case, not admin-of-the-actual-active-org", async () => {
	const attacker: RaceUser = {
		id: "attacker2",
		sessionOrgId: "orgB", // now B is genuinely the resource org
		rolesByOrg: { orgA: "member", orgB: "admin" },
		liveRoleNoQuery: "admin",
	};
	const { url, handle } = await startServer(["orgA", "orgB"], { attacker2: attacker });
	mockOpenAiVerifyAlwaysOk();

	const put = await fetch(`${url}/api/org/voice-key`, {
		method: "PUT",
		headers: { ...cookie("attacker2"), "content-type": "application/json" },
		body: JSON.stringify({ apiKey: "sk-legit-org-b-key" }),
	});
	expect(put.status).toBe(200);
	const ctx = { db: handle.db, type: handle.type };
	expect((await getOrgSecret(ctx, "orgB", "openai"))?.plaintext).toBe("sk-legit-org-b-key");
	// org A is untouched — this admin never wrote anywhere but their own active org.
	expect(await getOrgSecret(ctx, "orgA", "openai")).toBeUndefined();
});

test("bridgeRole: plain member with no admin role anywhere still 403s regardless of query binding (sanity: the fix doesn't accidentally grant anything new)", async () => {
	const plain: RaceUser = { id: "plainmember", sessionOrgId: "orgC", rolesByOrg: { orgC: "member" }, liveRoleNoQuery: "member" };
	const { url } = await startServer(["orgC"], { plainmember: plain });
	mockOpenAiVerifyAlwaysOk();
	expect((await fetch(`${url}/api/org/voice`, { headers: cookie("plainmember") })).status).toBe(403);
});
