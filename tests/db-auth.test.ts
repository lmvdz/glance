/**
 * db-auth — DB-mode identity layer end to end on a real bound server.
 *
 * Proves the P1 wiring: with a better-auth instance attached, the daemon gates
 * /api on cookie sessions (not the bearer token), serves /api/auth/* via
 * better-auth, bridges the active-org role to an RBAC tier, and reports it on
 * /api/me — while a server WITHOUT an auth instance stays in today's FILE mode.
 *
 * Uses a real sqlite *file* (not :memory:) so better-auth's migrator and the
 * live instance, even if they open separate connections, hit the same database.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../src/db/index.ts";
import { makeAuth } from "../src/db/auth.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

/** Stash the `name=value` of every Set-Cookie into the jar (server-side fetch has no cookie store). */
function captureCookies(res: Response, jar: Map<string, string>): void {
	for (const sc of res.headers.getSetCookie()) {
		const pair = sc.split(";", 1)[0] ?? "";
		const eq = pair.indexOf("=");
		if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
}
function cookieHeader(jar: Map<string, string>): string {
	return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Grab a free port up front so trustedOrigins/baseURL match the bound server exactly (as cmdUp does). */
function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const p = probe.port;
	probe.stop(true);
	return p;
}

test("DB mode: sign-up → session → org → /api/me, with the session gate on /api", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbauth-"));
	const dbFile = path.join(dir, "app.sqlite");
	const prevUrl = process.env.DATABASE_URL;
	process.env.DATABASE_URL = `sqlite:${dbFile}`;
	cleanups.push(() => {
		if (prevUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = prevUrl;
	});

	// Foundation: openDatabase migrates better-auth + app tables against the shared dialect.
	const dbHandle = await openDatabase();
	expect(dbHandle).not.toBeNull();
	if (!dbHandle) return;
	cleanups.push(() => dbHandle.close());

	const port = freePort();
	const origin = `http://127.0.0.1:${port}`;
	// Mirror cmdUp's wiring: concrete reachable origins + a baseURL matching the bound daemon.
	const auth = makeAuth({
		dialect: dbHandle.dialect,
		type: dbHandle.type,
		trustedOrigins: [origin, `http://localhost:${port}`],
		baseURL: origin,
	});

	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port, auth, db: dbHandle });
	const url = server.start();
	cleanups.push(async () => {
		await mgr.stop();
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	// PUBLIC mode probe — no auth, advertises DB mode.
	const mode = await (await fetch(`${url}/api/auth/mode`)).json();
	expect(mode).toEqual({ mode: "db" });

	// Unauthenticated /api is gated by the session, not the bearer token.
	expect((await fetch(`${url}/api/agents`)).status).toBe(401);

	const jar = new Map<string, string>();
	const email = "op@example.com";

	// Sign up → 200 + session cookie. (First POST carries no cookie, so better-auth skips the origin check.)
	const signup = await fetch(`${url}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ name: "Op One", email, password: "hunter2-strong" }),
	});
	expect(signup.status).toBe(200);
	captureCookies(signup, jar);
	expect(jar.size).toBeGreaterThan(0);

	// /api/me with the session: identity echoed, role present, no active org yet ⇒ operator.
	const me1 = await (await fetch(`${url}/api/me`, { headers: { cookie: cookieHeader(jar) } })).json();
	expect(me1.mode).toBe("db");
	expect(me1.user.email).toBe(email);
	expect(me1.role).toBe("operator");
	expect(me1.activeOrganizationId).toBeNull();

	// Create an org (cookied POST ⇒ better-auth validates Origin against trustedOrigins).
	const createRes = await fetch(`${url}/api/auth/organization/create`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, cookie: cookieHeader(jar) },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	});
	expect(createRes.status).toBe(200);
	captureCookies(createRes, jar);
	const org = await createRes.json();
	expect(typeof org.id).toBe("string");

	// Set it active.
	const setActive = await fetch(`${url}/api/auth/organization/set-active`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, cookie: cookieHeader(jar) },
		body: JSON.stringify({ organizationId: org.id }),
	});
	expect(setActive.status).toBe(200);
	captureCookies(setActive, jar);

	// /api/me now reflects the active org; creator is owner ⇒ bridged tier admin.
	const me2 = await (await fetch(`${url}/api/me`, { headers: { cookie: cookieHeader(jar) } })).json();
	expect(me2.activeOrganizationId).toBe(org.id);
	expect(me2.role).toBe("admin");

	// The session passes the /api gate.
	const agents = await fetch(`${url}/api/agents`, { headers: { cookie: cookieHeader(jar) } });
	expect(agents.status).toBe(200);
	expect(Array.isArray(await agents.json())).toBe(true);
});

test("FILE mode: no auth instance ⇒ mode=file and today's tokenless gate (loopback = admin)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fileauth-"));
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 }); // no auth, no token
	const url = server.start();
	cleanups.push(async () => {
		await mgr.stop();
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	expect(await (await fetch(`${url}/api/auth/mode`)).json()).toEqual({ mode: "file" });
	// Tokenless server = loopback/unit-test mode: every request is admin, so /api/agents is open.
	expect((await fetch(`${url}/api/agents`)).status).toBe(200);
	// /api/me in FILE mode returns the bare mode marker.
	expect(await (await fetch(`${url}/api/me`)).json()).toEqual({ mode: "file" });
});
