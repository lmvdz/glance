/**
 * Spend controls that bound what the daemon can actually see (plans/voice-db-mode/
 * 04-spend-controls.md). Today's cap counted MINTS; every mint is a live provider-side credential
 * and all duration/idle caps live in the browser, so an operator-tier member could skip the React
 * app, POST the mint route directly, and drive their own WebRTC client with no server-side bound at
 * all. BYO changes WHO pays, not WHO can burn.
 *
 * Covers this concern's own Verify bullets:
 *   - Establishment TTL default/override — see tests/voice-token.test.ts (`mintOpenAiToken` unit
 *     tests), which pin `expires_after.seconds` directly against the mocked provider request.
 *   - Durable per-org concurrency cap: a third mint inside the window 429s and the refusal is
 *     auditable; the cap survives a simulated daemon RESTART (a fresh in-memory map could not).
 *   - Mint audit written in BOTH modes, actor `db:<userId>` in DB mode (never role-derived — it's
 *     the SAME actor the server's own auth layer resolved), and the provider's own session id
 *     present in the DB-mode audit row.
 *   - Kill switch (`enabled:false` refuses the next mint immediately) is already covered end-to-end
 *     by tests/voice-token.test.ts's "DB mode: disabling the org's key…" test (concern 03) — the
 *     resolver this concern's mint path calls is unchanged, so it isn't re-tested here.
 *   - Mutation proof: the concurrency test below asserts the EXACT N/N+1 boundary (N succeeds, the
 *     very next one 429s) — deleting the concurrency check makes the N+1th assertion the one that
 *     goes red, not a vaguer "some requests fail" shape.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import type { OrgContext } from "../src/dal/context.ts";
import { deleteOrgAuditRow, finalizeOrgAuditDetail, FileStore, putOrgSecret, reserveOrgAuditSlot } from "../src/dal/store.ts";
import { openDatabase, type DbHandle } from "../src/db/index.ts";
import { ManagerRegistry } from "../src/manager-registry.ts";
import { initMasterKey } from "../src/secrets.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer, type AuthInstance } from "../src/server.ts";
import { readAudit } from "../src/audit.ts";

const OPENAI_MINT_URL = "https://api.openai.com/v1/realtime/client_secrets";
const realFetch = globalThis.fetch;

// Same fixed 32-byte master key convention as tests/voice-token.test.ts / tests/secrets.test.ts /
// tests/org-secret-rls.test.ts.
const KEY_HEX = "6cd547ba03603954b4d5e1ebe7a7f8720f005c6d57ce200cb4b30dda4be8a0d0";

const SAVED_ENV: Record<string, string | undefined> = {
	OMP_SQUAD_VOICE_ENABLED: process.env.OMP_SQUAD_VOICE_ENABLED,
	OMP_SQUAD_VOICE_OPENAI_API_KEY: process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY,
	OMP_SQUAD_VOICE_MINT_RATE_PER_MIN: process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN,
	OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG: process.env.OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG,
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

let mintSeq = 0;
/** Intercepts only the OpenAI mint URL, returning a fresh `ek_`/`sess_` pair each call — every
 *  other fetch (including the test's own calls into the local SquadServer under test) passes
 *  through unmodified. Mirrors tests/voice-token.test.ts's `mockOpenAiMint`. */
function mockOpenAiMintAlwaysOk(): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url !== OPENAI_MINT_URL) return realFetch(input as never, init);
		mintSeq++;
		return new Response(JSON.stringify({ value: `ek_${mintSeq}`, expires_at: 1, session: { id: `sess_${mintSeq}` } }), { status: 200 });
	}) as typeof fetch;
}

/** Same as `mockOpenAiMintAlwaysOk` but with a real `setTimeout` delay before resolving — the shape
 *  a real provider round trip has. Regression fixture for the check-then-act race: the old cap
 *  counted `voice.mint` audit rows BEFORE this delay and only wrote the row AFTER it, so every
 *  request in flight during the delay saw the same stale count. Reserving the audit row before the
 *  delay (the fix) closes that window regardless of how long the mint takes. */
function mockOpenAiMintAlwaysOkWithLatency(delayMs: number): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url !== OPENAI_MINT_URL) return realFetch(input as never, init);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		mintSeq++;
		return new Response(JSON.stringify({ value: `ek_${mintSeq}`, expires_at: 1, session: { id: `sess_${mintSeq}` } }), { status: 200 });
	}) as typeof fetch;
}

interface DbUser {
	id: string;
	orgId?: string;
	role?: "member" | "admin" | "owner";
}

/** Mirrors tests/voice-token.test.ts's `dbAuthStubFor`. */
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

/** Minimal stand-in for the bits of `SquadManager` the registry's own lifecycle code touches —
 *  mirrors tests/voice-token.test.ts's `FakeManager`/`seedOrgs` pair. `recordAudit` is a real, if
 *  inert, method: a successful mint best-effort-calls it for the JSONL trail (concern 04). */
interface FakeManager {
	list(): unknown[];
	off(event: "event", listener: (e: unknown) => void): void;
	stop(): Promise<void>;
	recordAudit(actor: unknown, action: string, target: string | null, outcome?: "ok" | "error", detail?: string, source?: string): Promise<void>;
}
interface RegistryInternals {
	managers: Map<string, { manager: FakeManager; listener: (e: unknown) => void; lastUsed: number }>;
}
function seedOrgs(registry: ManagerRegistry, orgIds: string[]): void {
	const internals = registry as unknown as RegistryInternals;
	for (const id of orgIds) {
		internals.managers.set(id, { manager: { list: () => [], off: () => {}, stop: async () => {}, recordAudit: async () => {} }, listener: () => {}, lastUsed: Date.now() });
	}
}

/** Boots a DB-mode server against `dir` (an already-migrated state dir, or a fresh one when
 *  `seedOrg` is set) WITHOUT deleting `dir` on cleanup — the concurrency-cap-survives-restart test
 *  below needs the same sqlite file to outlive one server's stop() so a second server can reopen it,
 *  proving the cap is backed by the DB and not an in-memory map that a real restart would reset. */
async function bootDbModeServer(dir: string, orgIds: string[], users: Record<string, DbUser>): Promise<{ url: string; ctx: OrgContext; handle: DbHandle; stop: () => Promise<void> }> {
	const handle = await openDatabase();
	if (!handle) throw new Error("openDatabase returned null in DB mode");
	const ctx: OrgContext = { db: handle.db, type: handle.type };
	for (const id of orgIds) {
		const exists = await handle.db.selectFrom("organization").select("id").where("id", "=", id).executeTakeFirst();
		if (!exists) await handle.db.insertInto("organization").values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() }).execute();
	}
	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator: { id: "test-op", origin: "local" } });
	seedOrgs(registry, orgIds);
	const server = new SquadServer(undefined, { port: 0, auth: dbAuthStubFor(users), db: handle, registry });
	const url = server.start();
	return { url, ctx, handle, stop: async () => { server.stop(); await handle.close(); } };
}

test("durable per-org concurrency cap: N=2 admits two mints, the third 429s, and the refusal is auditable", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG = "2";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-spend-cap-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const { url, ctx, handle, stop } = await bootDbModeServer(dir, ["orgCap"], { userCap: { id: "user-cap", orgId: "orgCap", role: "member" } });
	cleanups.push(async () => {
		await stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	await putOrgSecret(ctx, "orgCap", "openai", "sk-org-cap-key", "db:user-cap");
	mockOpenAiMintAlwaysOk();

	const mint = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userCap" } });
	expect((await mint()).status).toBe(200);
	expect((await mint()).status).toBe(200);
	// The mutation-sensitive boundary: N=2 admitted, the very next one must be refused.
	const third = await mint();
	expect(third.status).toBe(429);
	// Named honestly as a mints-per-window rate cap, not a "someone else is on a call" concurrency
	// signal a member could misread as presence — DESIGN.md "a rate cap is not a budget" cuts both
	// ways.
	const thirdBody = await third.text();
	expect(thirdBody).toContain("voice mint limit");
	expect(thirdBody).toContain("per 60 minutes");
	expect(thirdBody).not.toContain("concurrency");

	const refusalRows = await handle.db.selectFrom("audit").selectAll().where("org_id", "=", "orgCap").where("action", "=", "voice.mint.refused").execute();
	expect(refusalRows.length).toBe(1);
	expect(refusalRows[0]?.actor).toBe("db:user-cap");
	// The refusal must NOT itself count toward the cap it enforces (a distinct action name) — proven
	// by the successful-mint count staying exactly 2 despite the refusal row existing.
	const mintRows = await handle.db.selectFrom("audit").selectAll().where("org_id", "=", "orgCap").where("action", "=", "voice.mint").execute();
	expect(mintRows.length).toBe(2);
});

test("durable per-org concurrency cap holds under PARALLEL mints: cap=1, 8 concurrent POSTs against a mint mock with real provider latency admit exactly 1 and write exactly 1 voice.mint audit row", async () => {
	// Regression for the check-then-act race: the old cap counted this org's mint-audit rows BEFORE
	// `mintVoiceToken`'s network round trip and only wrote the audit row it counts AFTER the mint
	// returned. Every request in flight during that window saw the same stale (pre-insert) count,
	// so N+K parallel mints could all pass regardless of the configured cap — proven live (8 parallel
	// POSTs, cap=1, all 8 returned 200). The fix reserves the audit row BEFORE the mint
	// (`reserveOrgAuditSlot`, count+insert in one transaction), so a burst of concurrent requests can
	// no longer all observe the same pre-reservation count.
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG = "1";
	// Isolate the org-level concurrency cap from the per-actor pre-filter (default 6/min) — this test
	// proves the DURABLE cap holds under concurrency, not the pre-filter, so the pre-filter must not
	// itself absorb any of the 8 parallel requests.
	process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN = "100";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-spend-parallel-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const { url, handle, ctx, stop } = await bootDbModeServer(dir, ["orgParallel"], { userP: { id: "user-p", orgId: "orgParallel", role: "member" } });
	cleanups.push(async () => {
		await stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	await putOrgSecret(ctx, "orgParallel", "openai", "sk-org-parallel-key", "db:user-p");
	mockOpenAiMintAlwaysOkWithLatency(150);

	const mint = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userP" } });
	const results = await Promise.all(Array.from({ length: 8 }, () => mint()));
	const statuses = results.map((r) => r.status).sort((a, b) => a - b);
	// Exactly one 200, the other seven 429 — not "at least one 429", the exact N/N+K boundary.
	expect(statuses).toEqual([200, 429, 429, 429, 429, 429, 429, 429]);

	const mintRows = await handle.db.selectFrom("audit").selectAll().where("org_id", "=", "orgParallel").where("action", "=", "voice.mint").execute();
	expect(mintRows.length).toBe(1);
	const refusalRows = await handle.db.selectFrom("audit").selectAll().where("org_id", "=", "orgParallel").where("action", "=", "voice.mint.refused").execute();
	expect(refusalRows.length).toBe(7);
});

test("durable per-org concurrency cap survives a simulated daemon restart (a fresh in-memory map could not)", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG = "1";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-spend-restart-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	mockOpenAiMintAlwaysOk();

	// First "process": one server instance, mints exactly up to the cap (N=1), then stops — the way
	// a real daemon shuts down, not a crash mid-write.
	const first = await bootDbModeServer(dir, ["orgRestart"], { userR: { id: "user-r", orgId: "orgRestart", role: "member" } });
	await putOrgSecret(first.ctx, "orgRestart", "openai", "sk-org-restart-key", "db:user-r");
	const mintFirst = () => fetch(`${first.url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userR" } });
	expect((await mintFirst()).status).toBe(200);
	await first.stop();

	// Second "process": a brand-new SquadServer + ManagerRegistry + DB handle reopened against the
	// SAME sqlite file — nothing but the persisted `audit` rows carries state across this boundary.
	// An in-memory map (the rejected draft) would reset to empty here and wrongly admit this mint.
	const second = await bootDbModeServer(dir, ["orgRestart"], { userR: { id: "user-r", orgId: "orgRestart", role: "member" } });
	cleanups.push(async () => {
		await second.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const mintSecond = () => fetch(`${second.url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userR" } });
	expect((await mintSecond()).status).toBe(429);
});

test("durable per-org concurrency cap: once the window slides past the old mints, a new mint is admitted again", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MAX_CONCURRENT_PER_ORG = "1";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-spend-slide-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const { url, ctx, handle, stop } = await bootDbModeServer(dir, ["orgSlide"], { userS: { id: "user-s", orgId: "orgSlide", role: "member" } });
	cleanups.push(async () => {
		await stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	await putOrgSecret(ctx, "orgSlide", "openai", "sk-org-slide-key", "db:user-s");
	mockOpenAiMintAlwaysOk();

	const mint = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userS" } });
	expect((await mint()).status).toBe(200);
	expect((await mint()).status).toBe(429); // cap of 1 already hit

	// Backdate the existing mint row to well outside the provider's max-session window (60 min) —
	// simulating time passing, since a live test can't actually wait an hour.
	await handle.db.updateTable("audit").set({ at: Date.now() - 61 * 60_000 }).where("org_id", "=", "orgSlide").where("action", "=", "voice.mint").execute();
	expect((await mint()).status).toBe(200);
});

test("mint audit in DB mode: actor is db:<userId> (never role-derived) and the provider's own session id is recorded", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-spend-audit-db-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const { url, ctx, handle, stop } = await bootDbModeServer(dir, ["orgAudit"], { userAu: { id: "user-au", orgId: "orgAudit", role: "admin" } });
	cleanups.push(async () => {
		await stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	await putOrgSecret(ctx, "orgAudit", "openai", "sk-org-audit-key", "db:user-au");
	mockOpenAiMintAlwaysOk();

	const res = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userAu" } });
	expect(res.status).toBe(200);

	const rows = await handle.db.selectFrom("audit").selectAll().where("org_id", "=", "orgAudit").where("action", "=", "voice.mint").execute();
	expect(rows.length).toBe(1);
	const row = rows[0];
	if (!row) throw new Error("expected one voice.mint audit row");
	// db:<userId> — the SAME actor the server's own DB-mode session resolution produces, not
	// re-derived from `role` here (an "admin" role must never leak into the actor string).
	expect(row.actor).toBe("db:user-au");
	expect(row.actor).not.toContain("admin");
	expect(row.target).toBe("openai");
	const detail = JSON.parse(row.detail ?? "{}") as { providerSessionId?: string; source?: string };
	expect(typeof detail.providerSessionId).toBe("string");
	expect(detail.providerSessionId?.startsWith("sess_")).toBe(true);
	expect(detail.source).toBe("voice");
	// `reserveOrgAuditSlot` stamps `pending: true` on insert (self-identifying reservation) —
	// `finalizeOrgAuditDetail` must overwrite `detail` wholesale on a successful mint, so a
	// completed row never carries the pending flag its own reservation left on it.
	expect((detail as { pending?: boolean }).pending).toBeUndefined();
});

test("mint audit in file mode: a voice.mint entry lands in the JSONL trail with the provider session id in its detail", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-file-mode-key";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-spend-audit-file-"));
	const store = new FileStore(dir);
	const manager = new SquadManager({ stateDir: dir, store });
	const server = new SquadServer(manager, { port: 0, token: "admin-tok" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	mockOpenAiMintAlwaysOk();

	const res = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	expect(res.status).toBe(200);

	const entries = await readAudit(dir, { action: "voice.mint" });
	expect(entries.length).toBe(1);
	expect(entries[0]?.target).toBe("openai");
	expect(entries[0]?.detail).toContain("sess_");
});

// ── Postgres SQL shape: reserveOrgAuditSlot / finalizeOrgAuditDetail / deleteOrgAuditRow ────────
//
// Every voice test above runs SQLite, where the transaction alone closes the check-then-act race
// (a single-writer connection serializes it for free). Postgres READ COMMITTED does NOT — that's
// the dialect the advisory lock exists for — yet nothing exercised the Postgres branch at all.
// Mirrors tests/org-secret-rls.test.ts's "Layer 2": a fake `pg`-shaped pool wired into a REAL
// `PostgresDialect` so the captured SQL text is what Kysely's real Postgres compiler would send to
// a live server, without needing one reachable in this sandbox.

function fakePostgresDb(opts: { countValue?: number } = {}): { db: Kysely<any>; calls: Array<{ sql: string; params: readonly unknown[] }> } {
	const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
	const client = {
		query: async (sql: string, params: readonly unknown[] = []) => {
			calls.push({ sql, params });
			if (/select count/i.test(sql)) return { command: "SELECT", rowCount: 1, rows: [{ n: opts.countValue ?? 0 }] };
			return { command: "SELECT", rowCount: 0, rows: [] };
		},
		release: () => {},
	};
	const pool = { connect: async () => client, end: async () => {} };
	const db = new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as any }) });
	return { db, calls };
}

test("Postgres: reserveOrgAuditSlot takes the advisory lock inside the transaction, after set_config, before counting, before inserting", async () => {
	const { db, calls } = fakePostgresDb({ countValue: 0 });
	const ctx: OrgContext = { db, type: "postgres" };
	const reservation = await reserveOrgAuditSlot(ctx, "orgPG", { actor: "db:user-pg", action: "voice.mint", target: "openai", source: "voice" }, 5, Date.now() - 1000);
	expect(reservation.reserved).toBe(true);

	const idxBegin = calls.findIndex((c) => /^begin$/i.test(c.sql.trim()));
	const idxSetConfig = calls.findIndex((c) => /set_config/i.test(c.sql));
	const idxLock = calls.findIndex((c) => /pg_advisory_xact_lock/i.test(c.sql));
	const idxCount = calls.findIndex((c) => /select count/i.test(c.sql));
	const idxInsert = calls.findIndex((c) => /insert into "audit"/i.test(c.sql));
	const idxCommit = calls.findIndex((c) => /^commit$/i.test(c.sql.trim()));
	// -1 (not found) would make every comparison below vacuously pass, so a missing statement must
	// fail loudly here rather than silently no-op the ordering assertion.
	for (const [name, idx] of [["begin", idxBegin], ["set_config", idxSetConfig], ["advisory lock", idxLock], ["count", idxCount], ["insert", idxInsert], ["commit", idxCommit]] as const) {
		expect(idx, `expected a "${name}" statement`).toBeGreaterThanOrEqual(0);
	}
	expect(idxBegin).toBeLessThan(idxSetConfig);
	expect(idxSetConfig).toBeLessThan(idxLock);
	expect(idxLock).toBeLessThan(idxCount);
	expect(idxCount).toBeLessThan(idxInsert);
	expect(idxInsert).toBeLessThan(idxCommit);

	// Scoped to this org+action specifically — a different org or a different action must hash to a
	// different lock key, so unrelated reservations never contend.
	expect(calls[idxLock]?.params).toContain("voice-audit-reserve:orgPG:voice.mint");

	// The reserved row is self-identifying as unfinalized even on the dialect the fix targets.
	const insertDetailParam = calls[idxInsert]?.params.find((p) => typeof p === "string" && p.includes("pending"));
	expect(insertDetailParam).toBeDefined();
	expect(JSON.parse(insertDetailParam as string)).toMatchObject({ pending: true, source: "voice" });
});

test("Postgres: reserveOrgAuditSlot refuses (no insert) once the count already meets cap, lock still taken", async () => {
	const { db, calls } = fakePostgresDb({ countValue: 5 });
	const ctx: OrgContext = { db, type: "postgres" };
	const reservation = await reserveOrgAuditSlot(ctx, "orgPG", { actor: "db:user-pg", action: "voice.mint", target: "openai" }, 5, Date.now() - 1000);
	expect(reservation.reserved).toBe(false);
	expect(calls.some((c) => /pg_advisory_xact_lock/i.test(c.sql))).toBe(true);
	expect(calls.some((c) => /insert into "audit"/i.test(c.sql))).toBe(false);
});

test("Postgres: reserveOrgAuditSlot takes no advisory lock under type=sqlite (SQLite serializes writers on its own)", async () => {
	const { db, calls } = fakePostgresDb({ countValue: 0 }); // dialect is irrelevant — the branch is gated on ctx.type, not the driver
	const ctx: OrgContext = { db, type: "sqlite" };
	await reserveOrgAuditSlot(ctx, "orgPG", { actor: "db:user-pg", action: "voice.mint", target: "openai" }, 5, Date.now() - 1000);
	expect(calls.some((c) => /pg_advisory_xact_lock/i.test(c.sql))).toBe(false);
	expect(calls.some((c) => /set_config/i.test(c.sql))).toBe(false);
});

test("Postgres: finalizeOrgAuditDetail updates exactly the reserved row (org_id + id) and clears the pending flag", async () => {
	const { db, calls } = fakePostgresDb();
	const ctx: OrgContext = { db, type: "postgres" };
	await finalizeOrgAuditDetail(ctx, "orgPG", 42, { detail: { providerSessionId: "sess_pg" }, source: "voice" });

	const update = calls.find((c) => /update "audit"/i.test(c.sql));
	expect(update).toBeDefined();
	expect(update?.sql).toMatch(/"org_id"\s*=\s*\$/);
	expect(update?.sql).toMatch(/"id"\s*=\s*\$/);
	expect(update?.params).toContain("orgPG");
	expect(update?.params).toContain(42);
	const detailParam = update?.params.find((p) => typeof p === "string" && p.includes("providerSessionId"));
	expect(detailParam).toBeDefined();
	const parsed = JSON.parse(detailParam as string);
	expect(parsed.providerSessionId).toBe("sess_pg");
	expect(parsed.pending).toBeUndefined();
});

test("Postgres: deleteOrgAuditRow deletes exactly the reserved row (org_id + id)", async () => {
	const { db, calls } = fakePostgresDb();
	const ctx: OrgContext = { db, type: "postgres" };
	await deleteOrgAuditRow(ctx, "orgPG", 42);

	const del = calls.find((c) => /delete from "audit"/i.test(c.sql));
	expect(del).toBeDefined();
	expect(del?.sql).toMatch(/"org_id"\s*=\s*\$/);
	expect(del?.sql).toMatch(/"id"\s*=\s*\$/);
	expect(del?.params).toContain("orgPG");
	expect(del?.params).toContain(42);
});
