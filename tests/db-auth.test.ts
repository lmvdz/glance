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
import { DEV_INSECURE_SECRET, makeAuth } from "../src/db/auth.ts";
import { secretBootDecision } from "../src/index.ts";
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

/** Spin a real DB-mode server on a fresh sqlite file + free port; registers its own cleanup.
 *  `token` enables the loopback bootstrap admin; `allowSignup` opens self-service sign-up. */
async function setupDbServer(opts: { token?: string; allowSignup?: boolean } = {}): Promise<{ url: string; origin: string; port: number }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbauth-"));
	const dbFile = path.join(dir, "app.sqlite");
	const prevUrl = process.env.DATABASE_URL;
	const prevSignup = process.env.OMP_SQUAD_ALLOW_SIGNUP;
	// Ambient WorkOS creds (e.g. a dev .env that Bun auto-loads) would flip `sso` on and make these
	// assertions non-deterministic — neutralize them for the duration of the server.
	const prevWorkos = { id: process.env.WORKOS_CLIENT_ID, key: process.env.WORKOS_API_KEY };
	delete process.env.WORKOS_CLIENT_ID;
	delete process.env.WORKOS_API_KEY;
	process.env.DATABASE_URL = `sqlite:${dbFile}`;
	// disableSignUp is read at makeAuth time, so set the env BEFORE building the auth instance.
	if (opts.allowSignup) process.env.OMP_SQUAD_ALLOW_SIGNUP = "1";
	else delete process.env.OMP_SQUAD_ALLOW_SIGNUP;

	const dbHandle = await openDatabase();
	if (!dbHandle) throw new Error("openDatabase returned null in DB mode");

	const port = freePort();
	const origin = `http://127.0.0.1:${port}`;
	const trustedOrigins = [origin, `http://localhost:${port}`];
	const auth = makeAuth({ dialect: dbHandle.dialect, type: dbHandle.type, trustedOrigins, baseURL: origin });

	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port, auth, db: dbHandle, token: opts.token, trustedOrigins });
	const url = server.start();
	cleanups.push(async () => {
		await mgr.stop();
		server.stop();
		await dbHandle.close();
		await fs.rm(dir, { recursive: true, force: true });
		if (prevUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = prevUrl;
		if (prevSignup === undefined) delete process.env.OMP_SQUAD_ALLOW_SIGNUP;
		else process.env.OMP_SQUAD_ALLOW_SIGNUP = prevSignup;
		if (prevWorkos.id !== undefined) process.env.WORKOS_CLIENT_ID = prevWorkos.id;
		if (prevWorkos.key !== undefined) process.env.WORKOS_API_KEY = prevWorkos.key;
	});
	return { url, origin, port };
}

test("DB mode: sign-up ⇒ viewer (read-only), cannot mutate, and cannot self-mint an org", async () => {
	const { url, origin } = await setupDbServer({ allowSignup: true });

	// Public probe advertises DB mode; /api is session-gated, not bearer-gated.
	expect(await (await fetch(`${url}/api/auth/mode`)).json()).toEqual({ mode: "db", allowSignup: true, socialProviders: [], sso: false });
	expect((await fetch(`${url}/api/agents`)).status).toBe(401);

	const jar = new Map<string, string>();
	// Sign-up succeeds because OMP_SQUAD_ALLOW_SIGNUP=1; first POST carries no cookie ⇒ origin check skipped.
	const signup = await fetch(`${url}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ name: "Op One", email: "op@example.com", password: "hunter2-strong" }),
	});
	expect(signup.status).toBe(200);
	captureCookies(signup, jar);
	expect(jar.size).toBeGreaterThan(0);

	// A brand-new user with no active org ⇒ viewer (read-only), NOT operator (F2).
	const me = await (await fetch(`${url}/api/me`, { headers: { cookie: cookieHeader(jar) } })).json();
	expect(me.mode).toBe("db");
	expect(me.role).toBe("viewer");
	expect(me.activeOrganizationId).toBeNull();

	// Viewer CAN read.
	expect((await fetch(`${url}/api/agents`, { headers: { cookie: cookieHeader(jar) } })).status).toBe(200);

	// Viewer CANNOT mutate: POST /api/command requires operator. Same-origin ⇒ F4 passes, RBAC denies.
	const mutate = await fetch(`${url}/api/command`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, cookie: cookieHeader(jar) },
		body: JSON.stringify({ type: "snapshot" }),
	});
	expect(mutate.status).toBe(403);

	// Self-escalation closed: a plain session user cannot create an org (allowUserToCreateOrganization:false),
	// so the org-owner ⇒ admin ⇒ /api/upgrade RCE path is gone.
	const createOrg = await fetch(`${url}/api/auth/organization/create`, {
		method: "POST",
		headers: { "content-type": "application/json", origin, cookie: cookieHeader(jar) },
		body: JSON.stringify({ name: "Acme", slug: "acme" }),
	});
	expect(createOrg.status).toBe(403);
});

test("DB mode: a loopback admin bearer token bootstraps to admin and can mutate", async () => {
	const token = "bootstrap-admin-token-xxxxxxxx";
	const { url } = await setupDbServer({ token });
	const bearer = { authorization: `Bearer ${token}` };

	// No token + no session ⇒ DB mode rejects.
	expect((await fetch(`${url}/api/agents`)).status).toBe(401);
	// A wrong token gets no bootstrap.
	expect((await fetch(`${url}/api/agents`, { headers: { authorization: "Bearer wrong-token" } })).status).toBe(401);

	// Loopback + valid admin token ⇒ authenticated read with no cookie/session (break-glass).
	expect((await fetch(`${url}/api/agents`, { headers: bearer })).status).toBe(200);

	// …and can mutate (POST /api/features needs operator; bootstrap grants admin). No Origin ⇒ CLI-style.
	const created = await fetch(`${url}/api/features`, {
		method: "POST",
		headers: { ...bearer, "content-type": "application/json" },
		body: JSON.stringify({ title: "bootstrapped" }),
	});
	expect(created.status).toBe(200);

	// The mutation took effect.
	const feats = await (await fetch(`${url}/api/features`, { headers: bearer })).json();
	expect(feats.some((f: { title: string }) => f.title === "bootstrapped")).toBe(true);
});

test("DB mode: a foreign-Origin mutation is rejected as cross-site (F4)", async () => {
	const token = "bootstrap-admin-token-xxxxxxxx";
	const { url } = await setupDbServer({ token });
	const evil = "http://evil.example";

	// Even with a valid admin token, a foreign Origin on a mutation is blocked before auth runs.
	const res = await fetch(`${url}/api/features`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: evil },
		body: JSON.stringify({ title: "xss" }),
	});
	expect(res.status).toBe(403);
	expect(await res.text()).toBe("forbidden origin");

	// A read with a foreign Origin still passes (only mutations are origin-gated).
	expect((await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${token}`, origin: evil } })).status).toBe(200);
});

test("FILE mode: no auth instance ⇒ mode=file and today's tokenless gate (loopback = admin)", async () => {
	const prevSignup = process.env.OMP_SQUAD_ALLOW_SIGNUP;
	delete process.env.OMP_SQUAD_ALLOW_SIGNUP;
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fileauth-"));
	// makeServer's db-mode tests set OMP_SQUAD_ALLOW_SIGNUP and only restore it in afterAll
	// cleanups, which run after this test — isolate so their leakage can't flip allowSignup.
	const prevSignup = process.env.OMP_SQUAD_ALLOW_SIGNUP;
	delete process.env.OMP_SQUAD_ALLOW_SIGNUP;
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 }); // no auth, no token
	const url = server.start();
	cleanups.push(async () => {
		await mgr.stop();
		server.stop();
		if (prevSignup === undefined) delete process.env.OMP_SQUAD_ALLOW_SIGNUP;
		else process.env.OMP_SQUAD_ALLOW_SIGNUP = prevSignup;
		await fs.rm(dir, { recursive: true, force: true });
		if (prevSignup === undefined) delete process.env.OMP_SQUAD_ALLOW_SIGNUP;
		else process.env.OMP_SQUAD_ALLOW_SIGNUP = prevSignup;
	});

	// File mode never advertises signup, social providers, or SSO (no auth instance to sign up against).
	expect(await (await fetch(`${url}/api/auth/mode`)).json()).toEqual({ mode: "file", allowSignup: false, socialProviders: [], sso: false });
	// Tokenless server = loopback/unit-test mode: every request is admin, so /api/agents is open.
	expect((await fetch(`${url}/api/agents`)).status).toBe(200);
	// /api/me in FILE mode returns the bare mode marker.
	expect(await (await fetch(`${url}/api/me`)).json()).toEqual({ mode: "file" });
});

test("secretBootDecision: weak secret refuses non-loopback, warns on loopback, ok when strong", () => {
	// Weak (unset/empty/dev-default) on a non-loopback bind ⇒ refuse to boot.
	expect(secretBootDecision(undefined, "0.0.0.0")).toBe("refuse");
	expect(secretBootDecision("", "0.0.0.0")).toBe("refuse");
	expect(secretBootDecision(DEV_INSECURE_SECRET, "0.0.0.0")).toBe("refuse");
	expect(secretBootDecision(DEV_INSECURE_SECRET, "192.168.1.5")).toBe("refuse");
	// Weak on loopback ⇒ warn but allow (local dev).
	expect(secretBootDecision(undefined, "127.0.0.1")).toBe("warn");
	expect(secretBootDecision(undefined, "localhost")).toBe("warn");
	expect(secretBootDecision(DEV_INSECURE_SECRET, "::1")).toBe("warn");
	// A strong secret is fine anywhere.
	expect(secretBootDecision("a-strong-32-byte-hex-secret-value", "0.0.0.0")).toBe("ok");
});
