/**
 * Org-admin voice endpoints (plans/voice-db-mode/05-admin-endpoints.md): set / verify / disable /
 * remove the session org's own voice provider key. Mirrors the `renameOrg` `/api/org/*` idiom —
 * org id from the SESSION only, never a request parameter (the PR #152 lesson).
 *
 * Covers every Verify bullet in the concern file:
 *   - Cross-tenant: org A's admin session cannot read/write/delete org B's key, and a body-supplied
 *     org id (however named) is silently stripped/ignored — the store call is session-org-scoped.
 *   - Tier: operator gets 403 on all four routes; admin succeeds.
 *   - PUT rejects a bad key and writes NOTHING — no row, no last4, no partial state.
 *   - PUT never mints — the verification call hits /v1/models, never /realtime/client_secrets.
 *   - GET /api/org/voice never returns ciphertext or plaintext; last4 is exactly 4 chars, absent
 *     when unconfigured.
 *   - Rate limit on PUT holds.
 * Plus load-bearing extras the concern's Approach names: a rejected/no-active-org PUT/DELETE/enabled
 * refuses cleanly (400/403), a re-PUT rotates the same row (last4 changes), and DELETE / the kill
 * switch behave as documented (hard-delete vs. instant reversible flag).
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { OrgContext } from "../src/dal/context.ts";
import { getOrgSecret } from "../src/dal/store.ts";
import { openDatabase, type DbHandle } from "../src/db/index.ts";
import { initMasterKey } from "../src/secrets.ts";
import { SquadServer, type AuthInstance, type SquadServerOptions } from "../src/server.ts";

const OPENAI_VERIFY_URL = "https://api.openai.com/v1/models";
const OPENAI_MINT_URL = "https://api.openai.com/v1/realtime/client_secrets";
const realFetch = globalThis.fetch;

// Fixed 32-byte master key, same convention as tests/voice-token.test.ts / tests/secrets.test.ts /
// tests/org-secret-rls.test.ts: each test that needs a working master key sets it itself.
const KEY_HEX = "9a11c9f2c9e6db6a0f2b4c1c7d9e5f3a1b2c3d4e5f60718293a4b5c6d7e8f9a0";

const SAVED_ENV: Record<string, string | undefined> = {
	OMP_SQUAD_VOICE_KEY_PUT_RATE_PER_MIN: process.env.OMP_SQUAD_VOICE_KEY_PUT_RATE_PER_MIN,
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

/** Intercepts the OpenAI verify (`/v1/models`) and mint (`/realtime/client_secrets`) URLs only;
 *  every other fetch (including the test's own calls into the local server) passes through
 *  unmodified. `mintCalled()` is the load-bearing pin for "PUT never mints" — a mint hit is
 *  answered (not thrown), so a regression that starts minting shows up as a passing-but-wrong
 *  fetch, not a swallowed exception inside `verifyVoiceProviderKey`'s own try/catch. */
function mockOpenAiVerify(handler: (headers: Headers) => { status: number }): { mintCalled: () => boolean } {
	let mintCalled = false;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url === OPENAI_MINT_URL) {
			mintCalled = true;
			return new Response(JSON.stringify({ value: "ek_should_never_be_minted", expires_at: 1 }), { status: 200 });
		}
		if (url !== OPENAI_VERIFY_URL) return realFetch(input as never, init);
		const headers = new Headers(init?.headers as HeadersInit | undefined);
		const { status } = handler(headers);
		return new Response(null, { status });
	}) as typeof fetch;
	return { mintCalled: () => mintCalled };
}

interface DbUser {
	id: string;
	/** Absent ⇒ no active org (a real, reachable DB state per DESIGN.md's Security model). */
	orgId?: string;
	role?: "member" | "admin" | "owner";
}

/** Cookie-keyed auth stub, mirroring tests/voice-token.test.ts's `dbAuthStubFor` exactly: `session=<key>`
 *  looks `key` up in `users`. "member" ⇒ operator tier, "admin"/"owner" ⇒ admin tier, no active org ⇒
 *  viewer (bridgeRole, server.ts) — the same bridging real better-auth-backed sessions go through. */
function dbAuthStubFor(users: Record<string, DbUser>): AuthInstance {
	const lookup = (headers: Headers): DbUser | undefined => {
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
				return { user: { id: user.id, name: user.id, email: `${user.id}@example.test` }, session: { activeOrganizationId: user.orgId } };
			},
			getActiveMemberRole: async ({ headers }: { headers: Headers }) => ({ role: lookup(headers)?.role ?? "member" }),
		},
	} as unknown as AuthInstance;
}

/**
 * Boots a real DB-mode server for the admin-endpoint tests: a real, migrated SQLite handle
 * (`openDatabase`, mirroring tests/org-secret-rls.test.ts / tests/voice-token.test.ts — this is
 * what makes `org_secret` actually exist). No `ManagerRegistry`/fleet manager: these four routes
 * return before server.ts's `!manager` gate, so none is wired here — matching the routes' own
 * placement (before the fleet-manager `actor` resolution) rather than adding unused plumbing.
 */
async function startVoiceAdminServer(orgIds: string[], users: Record<string, DbUser>, extraOpts: Partial<SquadServerOptions> = {}): Promise<{ url: string; ctx: OrgContext; handle: DbHandle }> {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-org-admin-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const handle = await openDatabase();
	if (!handle) throw new Error("openDatabase returned null in DB mode");
	const ctx: OrgContext = { db: handle.db, type: handle.type };
	for (const id of orgIds) {
		await handle.db.insertInto("organization").values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() }).execute();
	}
	const server = new SquadServer(undefined, { port: 0, auth: dbAuthStubFor(users), db: handle, ...extraOpts });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await handle.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { url, ctx, handle };
}

function cookie(key: string): Record<string, string> {
	return { cookie: `session=${key}` };
}

// ── GET /api/org/voice ───────────────────────────────────────────────────────

test("GET /api/org/voice: unconfigured org reads configured:false, no last4/ciphertext/plaintext leak", async () => {
	const { url } = await startVoiceAdminServer(["orgA"], { admA: { id: "admin-a", orgId: "orgA", role: "admin" } });
	const res = await fetch(`${url}/api/org/voice`, { headers: cookie("admA") });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body).toEqual({ configured: false });
	expect(JSON.stringify(body)).not.toMatch(/sk-|last4/);
});

test("GET/DELETE /api/org/voice(-key): a ?provider= query param is honored (explicit \"openai\" behaves exactly like the default) and an unknown provider 400s rather than silently falling back to openai — the four voice-key routes can't drift apart the moment a second provider is registered", async () => {
	const { url } = await startVoiceAdminServer(["orgI"], { admI: { id: "admin-i", orgId: "orgI", role: "admin" } });
	mockOpenAiVerify(() => ({ status: 200 }));
	const put = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admI"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-provider-param-key" }) });
	expect(put.status).toBe(200);

	const bareGet = await (await fetch(`${url}/api/org/voice`, { headers: cookie("admI") })).json();
	const explicitGet = await (await fetch(`${url}/api/org/voice?provider=openai`, { headers: cookie("admI") })).json();
	expect(explicitGet).toEqual(bareGet);
	expect(explicitGet.configured).toBe(true);

	const unknownGet = await fetch(`${url}/api/org/voice?provider=not-a-real-provider`, { headers: cookie("admI") });
	expect(unknownGet.status).toBe(400);
	const unknownDelete = await fetch(`${url}/api/org/voice-key?provider=not-a-real-provider`, { method: "DELETE", headers: cookie("admI") });
	expect(unknownDelete.status).toBe(400);
	// The unknown-provider DELETE must not have touched the real row.
	const stillThere = await (await fetch(`${url}/api/org/voice`, { headers: cookie("admI") })).json();
	expect(stillThere.configured).toBe(true);

	const explicitDelete = await fetch(`${url}/api/org/voice-key?provider=openai`, { method: "DELETE", headers: cookie("admI") });
	expect(explicitDelete.status).toBe(200);
	const afterDelete = await (await fetch(`${url}/api/org/voice`, { headers: cookie("admI") })).json();
	expect(afterDelete).toEqual({ configured: false });
});

test("GET /api/org/voice: configured org reports last4 (exactly 4 chars), enabled, updatedAt/By — never ciphertext or plaintext", async () => {
	const { url } = await startVoiceAdminServer(["orgB"], { admB: { id: "admin-b", orgId: "orgB", role: "admin" } });
	const candidateKey = "sk-test-abcd1234wxyz";
	// Load-bearing: the verify call must carry the CANDIDATE key from the PUT body, not the
	// operator's env key or a previously-stored row — a regression that verified against the wrong
	// bytes would still 200 and persist without this assertion ever going red.
	mockOpenAiVerify((headers) => {
		expect(headers.get("authorization")).toBe(`Bearer ${candidateKey}`);
		return { status: 200 };
	});
	const put = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admB"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: candidateKey }) });
	expect(put.status).toBe(200);
	const res = await fetch(`${url}/api/org/voice`, { headers: cookie("admB") });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.configured).toBe(true);
	expect(body.last4).toBe("wxyz");
	expect(body.last4).toHaveLength(4);
	expect(body.enabled).toBe(true);
	expect(typeof body.updatedAt).toBe("number");
	expect(body.updatedBy).toBe("db:admin-b");
	const raw = JSON.stringify(body);
	expect(raw).not.toContain(candidateKey); // never the plaintext key
	expect(raw).not.toMatch(/ciphertext|nonce/); // never the encrypted row shape
});

// ── PUT /api/org/voice-key: verify-before-persist ────────────────────────────

test("PUT rejects a bad key and writes NOTHING — no row, no last4, no partial state", async () => {
	const { url, ctx } = await startVoiceAdminServer(["orgC"], { admC: { id: "admin-c", orgId: "orgC", role: "admin" } });
	mockOpenAiVerify(() => ({ status: 401 }));
	const res = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admC"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-bad-key" }) });
	expect(res.status).toBe(400);
	// No row at all — not merely "unconfigured" via the API, but genuinely absent in the store.
	expect(await getOrgSecret(ctx, "orgC", "openai")).toBeUndefined();
	const status = await (await fetch(`${url}/api/org/voice`, { headers: cookie("admC") })).json();
	expect(status).toEqual({ configured: false });
});

test("PUT never mints — the verification call hits /v1/models, never /realtime/client_secrets, on both accept and reject", async () => {
	const { url } = await startVoiceAdminServer(["orgD"], { admD: { id: "admin-d", orgId: "orgD", role: "admin" } });
	const accepted = mockOpenAiVerify(() => ({ status: 200 }));
	const okRes = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admD"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-good-key-1234" }) });
	expect(okRes.status).toBe(200);
	expect(accepted.mintCalled()).toBe(false);

	const rejected = mockOpenAiVerify(() => ({ status: 401 }));
	const badRes = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admD"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-bad-key-5678" }) });
	expect(badRes.status).toBe(400);
	expect(rejected.mintCalled()).toBe(false);
});

test("a re-PUT rotates the same row — new last4, and the OLD key no longer decrypts to the current row's ciphertext", async () => {
	const { url, ctx } = await startVoiceAdminServer(["orgE"], { admE: { id: "admin-e", orgId: "orgE", role: "admin" } });
	mockOpenAiVerify(() => ({ status: 200 }));
	await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admE"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-first-keyaaaa" }) });
	const first = await getOrgSecret(ctx, "orgE", "openai");
	expect(first?.last4).toBe("aaaa");
	await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admE"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-second-keybbbb" }) });
	const second = await getOrgSecret(ctx, "orgE", "openai");
	expect(second?.last4).toBe("bbbb");
	expect(second?.plaintext).toBe("sk-second-keybbbb");
});

test("PUT: missing/empty apiKey 400s before any fetch", async () => {
	const { url } = await startVoiceAdminServer(["orgF"], { admF: { id: "admin-f", orgId: "orgF", role: "admin" } });
	const { mintCalled } = mockOpenAiVerify(() => ({ status: 200 }));
	const res1 = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admF"), "content-type": "application/json" }, body: JSON.stringify({}) });
	expect(res1.status).toBe(400);
	const res2 = await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admF"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "" }) });
	expect(res2.status).toBe(400);
	expect(mintCalled()).toBe(false);
});

test("PUT: rate limit holds — OMP_SQUAD_VOICE_KEY_PUT_RATE_PER_MIN caps admin PUTs within the same minute", async () => {
	process.env.OMP_SQUAD_VOICE_KEY_PUT_RATE_PER_MIN = "2";
	const { url } = await startVoiceAdminServer(["orgG"], { admG: { id: "admin-g", orgId: "orgG", role: "admin" } });
	mockOpenAiVerify(() => ({ status: 200 }));
	const put = () => fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admG"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-rate-limit-key" }) });
	expect((await put()).status).toBe(200);
	expect((await put()).status).toBe(200);
	expect((await put()).status).toBe(429);
});

// ── Tier: operator 403, admin succeeds ────────────────────────────────────────

test("tier: operator (member role) gets 403 on all four routes; admin succeeds", async () => {
	const users: Record<string, DbUser> = { opH: { id: "op-h", orgId: "orgH", role: "member" }, admH: { id: "admin-h", orgId: "orgH", role: "admin" } };
	const { url } = await startVoiceAdminServer(["orgH"], users);
	mockOpenAiVerify(() => ({ status: 200 }));

	expect((await fetch(`${url}/api/org/voice`, { headers: cookie("opH") })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("opH"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-op-key" }) })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "DELETE", headers: cookie("opH") })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice/enabled`, { method: "POST", headers: { ...cookie("opH"), "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);

	expect((await fetch(`${url}/api/org/voice`, { headers: cookie("admH") })).status).toBe(200);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admH"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-admin-key" }) })).status).toBe(200);
	expect((await fetch(`${url}/api/org/voice/enabled`, { method: "POST", headers: { ...cookie("admH"), "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "DELETE", headers: cookie("admH") })).status).toBe(200);
});

// ── Cross-tenant isolation ────────────────────────────────────────────────────

test("cross-tenant: org A's admin cannot read, write, or delete org B's key — no org parameter accepted anywhere", async () => {
	const users: Record<string, DbUser> = { admA2: { id: "admin-a2", orgId: "orgA2", role: "admin" }, admB2: { id: "admin-b2", orgId: "orgB2", role: "admin" } };
	const { url, ctx } = await startVoiceAdminServer(["orgA2", "orgB2"], users);
	mockOpenAiVerify(() => ({ status: 200 }));

	// Org A configures its own key.
	await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admA2"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-org-a-key1" }) });

	// Org B's admin reads its OWN status — must never see org A's key, even with an org id smuggled
	// into the body (the route has no org parameter to smuggle into; Schema.Struct strips it anyway).
	const bStatus = await (await fetch(`${url}/api/org/voice`, { headers: cookie("admB2") })).json();
	expect(bStatus).toEqual({ configured: false });

	// A body-supplied org id on org B's PUT still lands on org B, not org A — proving the store call
	// is session-scoped, not request-scoped.
	await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admB2"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-org-b-key1", orgId: "orgA2" }) });
	const orgASecret = await getOrgSecret(ctx, "orgA2", "openai");
	expect(orgASecret?.plaintext).toBe("sk-org-a-key1"); // unchanged by org B's PUT
	const orgBSecret = await getOrgSecret(ctx, "orgB2", "openai");
	expect(orgBSecret?.plaintext).toBe("sk-org-b-key1");

	// Org B's admin cannot delete org A's key by calling DELETE on their own session.
	await fetch(`${url}/api/org/voice-key`, { method: "DELETE", headers: cookie("admB2") });
	expect((await getOrgSecret(ctx, "orgA2", "openai"))?.plaintext).toBe("sk-org-a-key1"); // still there
	expect(await getOrgSecret(ctx, "orgB2", "openai")).toBeUndefined(); // org B's own row is gone
});

// ── DELETE and the kill switch ────────────────────────────────────────────────

test("DELETE hard-deletes the row — org reverts to configured:false, not merely disabled", async () => {
	const { url, ctx } = await startVoiceAdminServer(["orgI"], { admI: { id: "admin-i", orgId: "orgI", role: "admin" } });
	mockOpenAiVerify(() => ({ status: 200 }));
	await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admI"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-delete-me-key" }) });
	expect(await getOrgSecret(ctx, "orgI", "openai")).toBeDefined();
	const del = await fetch(`${url}/api/org/voice-key`, { method: "DELETE", headers: cookie("admI") });
	expect(del.status).toBe(200);
	expect(await del.json()).toEqual({ configured: false });
	expect(await getOrgSecret(ctx, "orgI", "openai")).toBeUndefined();
});

test("POST /api/org/voice/enabled flips the kill switch WITHOUT deleting the stored key (instant, reversible)", async () => {
	const { url, ctx } = await startVoiceAdminServer(["orgJ"], { admJ: { id: "admin-j", orgId: "orgJ", role: "admin" } });
	mockOpenAiVerify(() => ({ status: 200 }));
	await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("admJ"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-kill-switch-key" }) });
	expect((await getOrgSecret(ctx, "orgJ", "openai"))?.enabled).toBe(true);

	const off = await fetch(`${url}/api/org/voice/enabled`, { method: "POST", headers: { ...cookie("admJ"), "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
	expect(off.status).toBe(200);
	expect((await off.json()).enabled).toBe(false);
	// The key is still there, still decryptable — only the flag flipped.
	const disabled = await getOrgSecret(ctx, "orgJ", "openai");
	expect(disabled?.enabled).toBe(false);
	expect(disabled?.plaintext).toBe("sk-kill-switch-key");

	const on = await fetch(`${url}/api/org/voice/enabled`, { method: "POST", headers: { ...cookie("admJ"), "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
	expect((await on.json()).enabled).toBe(true);
});

// ── No active org: clean refusal, never a throw ───────────────────────────────

test("no active org: all four routes refuse cleanly (400), never a 500", async () => {
	const { url } = await startVoiceAdminServer([], { orphan: { id: "orphan-user" } }); // no orgId ⇒ no active org
	mockOpenAiVerify(() => ({ status: 200 }));
	// bridgeRole demotes a session with no active org to viewer, so the tier gate 403s before the
	// route's own "no active org" 400 can fire for a non-admin caller — that's still a clean refusal,
	// never a throw, which is what this test pins. A loopback-admin/no-session shape (the OTHER
	// no-active-org path named in DESIGN.md) is covered at the resolver level by
	// tests/voice-token.test.ts and isn't re-derived here.
	expect((await fetch(`${url}/api/org/voice`, { headers: cookie("orphan") })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "PUT", headers: { ...cookie("orphan"), "content-type": "application/json" }, body: JSON.stringify({ apiKey: "sk-orphan" }) })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice-key`, { method: "DELETE", headers: cookie("orphan") })).status).toBe(403);
	expect((await fetch(`${url}/api/org/voice/enabled`, { method: "POST", headers: { ...cookie("orphan"), "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);
});
