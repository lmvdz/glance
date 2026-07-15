/**
 * Voice token mint + capability probe (plans/webapp-voice-lane/05-voice-token-endpoints.md,
 * plans/voice-db-mode/03-org-aware-resolver.md).
 *
 * Concern 03 rewrites the file-mode-only premise this file used to pin: DB mode no longer refuses
 * mint outright ("a single shared provider key, no per-org attribution/budget in v1"). The new
 * rule (DESIGN.md "Gate lockstep") — mint is refused PER ORG, only when the session's active org
 * has no configured, enabled key, never mode-wide — and ONE resolver (`voiceKeyFor` in
 * src/voice-token.ts) backs every capability read: the key lookup, the "any key?" probe, the
 * public provider list, the config probe, and the mint path, so the config probe and the mint
 * outcome can never disagree for any (mode, org, key-state) combination (the "old mic scar" pin,
 * extended per-org). File mode is untouched — it still reads the keyed env var, byte-for-byte.
 *
 * Covers every red-team guard named in the original concern file, plus concern 03's own:
 *   - envBool("OMP_SQUAD_VOICE_ENABLED") gate: both routes 404 (not disabled/501) when off.
 *   - Cross-tenant mint isolation (THE load-bearing pin): two orgs, two keys, the mocked
 *     provider's captured `Authorization` header proves org A's session never mints with org B's
 *     key, or the reverse.
 *   - No fallback to the operator's env key in DB mode, ever — even when one is configured.
 *   - Probe/mint agreement across every (mode, org, key-state) combination.
 *   - Decrypt-fails-closed and the kill switch: a corrupted or disabled row reads as no key,
 *     never a 500.
 *   - No root-factory bypass: the sentinel org id is resolved like any other.
 *   - No active org is a clean refusal, never a throw.
 *   - Per-actor mint rate cap (OMP_SQUAD_VOICE_MINT_RATE_PER_MIN), mirroring feedbackRateAllowed.
 *   - Closed provider switch / SSRF doctrine: an unknown provider id 400s BEFORE any fetch.
 *   - Viewer-scoped config: GET /api/voice/config never carries a `providers` key below operator.
 *   - `ek_` hygiene: the minted value and the raw provider response never reach console.*.
 *   - pinnedAtMint===false ⇒ flatPrice===true assertion at registry-definition time.
 *   - restActionTier regression: GET=viewer / POST=operator for /api/voice/*, called for real
 *     from src/authz.ts (not re-derived here) so a future authz edit can't silently drift.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { restActionTier } from "../src/authz.ts";
import type { OrgContext } from "../src/dal/context.ts";
import { FileStore, putOrgSecret, setOrgSecretEnabled } from "../src/dal/store.ts";
import { openDatabase, type DbHandle } from "../src/db/index.ts";
import { ManagerRegistry } from "../src/manager-registry.ts";
import { initMasterKey } from "../src/secrets.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { ROOT_FACTORY_ORG, SquadServer, type AuthInstance, type SquadServerOptions } from "../src/server.ts";
import { isKnownVoiceProvider, mintVoiceToken, orgHasKey, VOICE_SESSION_TOOLS, VOICE_TOKEN_TTL_MAX_S, voiceKeyFor, voiceTokenTtlSeconds, type VoiceKeyScope } from "../src/voice-token.ts";

const OPENAI_MINT_URL = "https://api.openai.com/v1/realtime/client_secrets";
const realFetch = globalThis.fetch;

// Fixed 32-byte master key for the DB-mode tests below (secrets.ts's `initMasterKey` test seam —
// see tests/secrets.test.ts / tests/org-secret-rls.test.ts for the same convention: each test that
// needs a working master key sets it itself, no shared ambient state assumed).
const KEY_HEX = "6cd547ba03603954b4d5e1ebe7a7f8720f005c6d57ce200cb4b30dda4be8a0d0";

const SAVED_ENV: Record<string, string | undefined> = {
	OMP_SQUAD_VOICE_ENABLED: process.env.OMP_SQUAD_VOICE_ENABLED,
	OMP_SQUAD_VOICE_OPENAI_API_KEY: process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY,
	OMP_SQUAD_VOICE_MODEL: process.env.OMP_SQUAD_VOICE_MODEL,
	OMP_SQUAD_VOICE_VOICE: process.env.OMP_SQUAD_VOICE_VOICE,
	OMP_SQUAD_VOICE_MINT_RATE_PER_MIN: process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN,
	OMP_SQUAD_VOICE_TOKEN_TTL_S: process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S,
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

/** Intercepts only the OpenAI mint URL; every other fetch (including the test's own calls into the
 *  local SquadServer under test) passes through to the real fetch unmodified. The `headers` param
 *  (plans/voice-db-mode/03-org-aware-resolver.md) is what makes cross-tenant mint isolation
 *  provable: the ONLY way to see which key a mint actually used is the `Authorization` header the
 *  daemon sent upstream — the request body never carries it. */
function mockOpenAiMint(handler: (body: unknown, headers: Headers) => { status: number; json?: unknown }): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url !== OPENAI_MINT_URL) return realFetch(input as never, init);
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		const headers = new Headers(init?.headers as HeadersInit | undefined);
		const { status, json } = handler(body, headers);
		return new Response(json !== undefined ? JSON.stringify(json) : undefined, { status });
	}) as typeof fetch;
}

/** Counts every non-localhost fetch (the test's own request into the local server also goes through
 *  `fetch`) — proving the SSRF guard returned before ANY outbound call, not merely before the one
 *  known provider URL. */
function countOpenAiMintCalls(): { calls: () => number } {
	let n = 0;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) n++;
		return realFetch(input as never, init);
	}) as typeof fetch;
	return { calls: () => n };
}

async function startServer(opts: { token?: string; roleTokens?: { operator?: string; viewer?: string }; auth?: AuthInstance } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-token-"));
	const store = new FileStore(dir);
	const manager = new SquadManager({ stateDir: dir, store });
	const server = new SquadServer(manager, { port: 0, ...opts });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { url };
}

interface DbUser {
	id: string;
	/** Absent ⇒ no active org (a real, reachable DB state per DESIGN.md's Security model). */
	orgId?: string;
	role?: "member" | "admin" | "owner";
}

/** Cookie-keyed auth stub for the DB-mode harness below: `session=<key>` looks `key` up in
 *  `users`. "member" ⇒ operator tier, "admin"/"owner" ⇒ admin tier, no active org ⇒ viewer
 *  (bridgeRole, server.ts) — the SAME bridging real better-auth-backed sessions go through. */
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

/** Minimal stand-in for the bits of `SquadManager` the registry's own lifecycle code touches
 *  (list/off/stop) — mirrors tests/ws-org-isolation.test.ts's `fakeManager`/`seed` pair. Rewritten
 *  for concern 04: the voice routes still resolve/refuse independently of `manager` (they can return
 *  before the `!manager` gate), but a SUCCESSFUL mint now best-effort-calls `manager.recordAudit`
 *  for the JSONL trail (both modes carry a mint audit line) — `recordAudit` is a real, if inert,
 *  method here rather than omitted, so that write doesn't crash against this stand-in. */
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

/**
 * Boots a real DB-mode server for the org-aware resolver tests: a real, migrated SQLite handle
 * (`openDatabase`, mirroring tests/org-secret-rls.test.ts — this is what makes `org_secret`
 * actually exist) plus a `ManagerRegistry` seeded with fake per-org fleets (mirrors
 * tests/ws-org-isolation.test.ts) — enough for `managerFor`'s org routing to resolve a real
 * `activeOrganizationId` without spinning up an actual fleet manager per org.
 */
async function startDbModeServer(orgIds: string[], users: Record<string, DbUser>, extraOpts: Partial<SquadServerOptions> = {}): Promise<{ url: string; ctx: OrgContext; handle: DbHandle }> {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-db-mode-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const handle = await openDatabase();
	if (!handle) throw new Error("openDatabase returned null in DB mode");
	const ctx: OrgContext = { db: handle.db, type: handle.type };
	for (const id of orgIds) {
		await handle.db.insertInto("organization").values({ id, name: `Org ${id}`, slug: `org-${id.toLowerCase()}`, createdAt: new Date().toISOString() }).execute();
	}
	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator: { id: "test-op", origin: "local" } });
	seedOrgs(registry, orgIds);
	const server = new SquadServer(undefined, { port: 0, auth: dbAuthStubFor(users), db: handle, registry, ...extraOpts });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await handle.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { url, ctx, handle };
}

// ── mintVoiceToken (unit-level, fetch mocked) ───────────────────────────────

test("mintVoiceToken maps a successful OpenAI mint to the uniform shape and pins session params server-side", async () => {
	let capturedBody: any;
	mockOpenAiMint((body) => {
		capturedBody = body;
		return { status: 200, json: { value: "ek_abc123", expires_at: 1_753_000_000, session: { id: "sess_1" } } };
	});
	process.env.OMP_SQUAD_VOICE_MODEL = "gpt-realtime-test";
	process.env.OMP_SQUAD_VOICE_VOICE = "aria";
	const result = await mintVoiceToken("openai", "sk-real-key");
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected ok:true");
	expect(result.token).toEqual({
		provider: "openai",
		value: "ek_abc123",
		expiresAt: 1_753_000_000,
		transport: "webrtc",
		pinnedAtMint: true,
	});
	// GA client_secrets shape (VERIFIED LIVE 2026-07-10): `type:"realtime"` + audio nested under
	// `audio.input`/`audio.output`. The old flat `session.voice`/`turn_detection`/
	// `input_audio_transcription` is the beta shape and 400s ("Unknown parameter: 'session.voice'").
	expect(capturedBody.session.type).toBe("realtime");
	expect(capturedBody.session.model).toBe("gpt-realtime-test");
	expect(capturedBody.session.audio.output.voice).toBe("aria");
	expect(capturedBody.session.audio.input.turn_detection).toBeNull(); // push-to-talk v1
	// Concern-audit finding 3: without this the browser's user-caption branch is permanently dormant
	// and the model's own paraphrase would render as the operator's words.
	expect(capturedBody.session.audio.input.transcription).toEqual({ model: "whisper-1" });
	expect(typeof capturedBody.session.instructions).toBe("string");
	expect(capturedBody.session.instructions.length).toBeGreaterThan(0);
	// Without tools the model could never emit a function_call — the whole lane would be inert
	// (concern 07's gap report). The four schemas are part of the pinned surface.
	expect(capturedBody.session.tools.map((t: { name: string }) => t.name)).toEqual([
		"prompt_agent",
		"spawn_agent",
		"fleet_status",
		"interrupt",
	]);
	// Flipped deliberately (plans/voice-db-mode/04-spend-controls.md): 3600s used to be pinned here.
	// The ephemeral token bounds ESTABLISHMENT, not call length (the provider caps a live session's
	// own duration independently) — 120s is the new default, env-overridable below.
	expect(capturedBody.expires_after).toEqual({ anchor: "created_at", seconds: 120 });
	// Currently discarded pre-concern-04 — the mint-audit write's cross-reference field.
	expect(result.providerSessionId).toBe("sess_1");
});

test("mintVoiceToken's expires_after seconds honors OMP_SQUAD_VOICE_TOKEN_TTL_S (concern 04's establishment window is env-overridable)", async () => {
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = "45";
	let capturedBody: any;
	mockOpenAiMint((body) => {
		capturedBody = body;
		return { status: 200, json: { value: "ek_ttl", expires_at: 1, session: {} } };
	});
	const result = await mintVoiceToken("openai", "sk-key");
	expect(result.ok).toBe(true);
	expect(capturedBody.expires_after).toEqual({ anchor: "created_at", seconds: 45 });
});

test("voiceTokenTtlSeconds clamps an absurdly large OMP_SQUAD_VOICE_TOKEN_TTL_S to VOICE_TOKEN_TTL_MAX_S (1 hour) — server.ts's durable per-org concurrency window (concern 02) adds this value to the provider's session cap, so an unbounded TTL would inflate it without limit", () => {
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = "999999";
	expect(voiceTokenTtlSeconds()).toBe(VOICE_TOKEN_TTL_MAX_S);
});

test("voiceTokenTtlSeconds passes a value at or below the ceiling through unchanged", () => {
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = String(VOICE_TOKEN_TTL_MAX_S);
	expect(voiceTokenTtlSeconds()).toBe(VOICE_TOKEN_TTL_MAX_S);
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = "45";
	expect(voiceTokenTtlSeconds()).toBe(45);
});

test("voiceTokenTtlSeconds still passes a non-positive configured value through faithfully — only the UPPER end is clamped, per its own doc comment", () => {
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = "0";
	expect(voiceTokenTtlSeconds()).toBe(0);
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = "-5";
	expect(voiceTokenTtlSeconds()).toBe(-5);
});

test("mintVoiceToken's expires_after seconds is clamped to VOICE_TOKEN_TTL_MAX_S even when OMP_SQUAD_VOICE_TOKEN_TTL_S is configured absurdly large", async () => {
	process.env.OMP_SQUAD_VOICE_TOKEN_TTL_S = "999999";
	let capturedBody: any;
	mockOpenAiMint((body) => {
		capturedBody = body;
		return { status: 200, json: { value: "ek_ttl_clamped", expires_at: 1, session: {} } };
	});
	const result = await mintVoiceToken("openai", "sk-key");
	expect(result.ok).toBe(true);
	expect(capturedBody.expires_after).toEqual({ anchor: "created_at", seconds: VOICE_TOKEN_TTL_MAX_S });
});

test("VOICE_SESSION_TOOLS stays deep-equal with the webapp dispatcher's VOICE_TOOL_DEFS (cross-build sync pin)", async () => {
	// The daemon pins the tool schemas at mint; the webapp dispatcher validates and executes the
	// resulting calls. Two builds, one contract — this pin is what keeps them from drifting apart
	// silently. Bun resolves the webapp's TS directly at test time; no build artifact involved.
	const webappTools = await import("../webapp/src/lib/voice/tools");
	expect(JSON.parse(JSON.stringify(VOICE_SESSION_TOOLS))).toEqual(
		JSON.parse(JSON.stringify(webappTools.VOICE_TOOL_DEFS)),
	);
});

test("mintVoiceToken defaults model/voice when the env vars are unset", async () => {
	delete process.env.OMP_SQUAD_VOICE_MODEL;
	delete process.env.OMP_SQUAD_VOICE_VOICE;
	let capturedBody: any;
	mockOpenAiMint((body) => {
		capturedBody = body;
		return { status: 200, json: { value: "ek_defaults", expires_at: 1, session: {} } };
	});
	const result = await mintVoiceToken("openai", "sk-key");
	expect(result.ok).toBe(true);
	expect(capturedBody.session.model).toBe("gpt-realtime-2.1");
	expect(capturedBody.session.audio.output.voice).toBe("marin");
});

test("mintVoiceToken 400s an unknown provider id BEFORE any fetch (SSRF doctrine)", async () => {
	const tracker = countOpenAiMintCalls();
	const result = await mintVoiceToken("xai", "some-key");
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected ok:false");
	expect(result.status).toBe(400);
	expect(tracker.calls()).toBe(0);
	expect(isKnownVoiceProvider("xai")).toBe(false);
	expect(isKnownVoiceProvider("openai")).toBe(true);
});

test("mintVoiceToken 501s when no API key is configured, without ever fetching", async () => {
	const tracker = countOpenAiMintCalls();
	const result = await mintVoiceToken("openai", undefined);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected ok:false");
	expect(result.status).toBe(501);
	expect(tracker.calls()).toBe(0);
});

test("mintVoiceToken surfaces a bounded 502 on an upstream failure without leaking the raw response", async () => {
	mockOpenAiMint(() => ({ status: 500, json: { error: { message: "internal", instructions: "leaked-session-text" } } }));
	const result = await mintVoiceToken("openai", "sk-key");
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected ok:false");
	expect(result.status).toBe(502);
	expect(result.message).not.toContain("leaked-session-text");
});

// ── restActionTier regression (RBAC doctrine: no new authz branch) ──────────

test("restActionTier: GET /api/voice/config = viewer, POST /api/voice/token = operator", () => {
	expect(restActionTier("GET", "/api/voice/config")).toBe("viewer");
	expect(restActionTier("POST", "/api/voice/token")).toBe("operator");
});

// ── HTTP-level: gate, DB-mode refusal, rate cap, provider closed-switch, config scoping ──

test("both voice routes 404 when OMP_SQUAD_VOICE_ENABLED is unset (default off)", async () => {
	delete process.env.OMP_SQUAD_VOICE_ENABLED;
	const { url } = await startServer({ token: "admin-tok" });
	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer admin-tok" } });
	expect(cfgRes.status).toBe(404);
	const tokRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	expect(tokRes.status).toBe(404);
});

test("both voice routes 404 when OMP_SQUAD_VOICE_ENABLED=0 explicitly", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "0";
	const { url } = await startServer({ token: "admin-tok" });
	expect((await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer admin-tok" } })).status).toBe(404);
});

test("GET /api/voice/config: viewer tier gets {enabled:false} — never a live button for a tier that can't mint; operator+ gets providers", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok", viewer: "view-tok" } });

	// A key IS configured, so before this fix the probe advertised {enabled:true} to a viewer — a
	// "Start voice call" button that always 403s on click, since POST /api/voice/token is
	// operator-tier (restActionTier). The probe must now agree with the mint route's own floor.
	const viewerRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer view-tok" } });
	expect(viewerRes.status).toBe(200);
	const viewerBody = await viewerRes.json();
	expect(viewerBody).toEqual({ enabled: false });
	expect("providers" in viewerBody).toBe(false);
	// Prove the button really would have died: the same viewer's own mint attempt 403s.
	const viewerMint = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer view-tok" } });
	expect(viewerMint.status).toBe(403);

	const opRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer op-tok" } });
	expect(opRes.status).toBe(200);
	const opBody = await opRes.json();
	expect(opBody.enabled).toBe(true);
	expect(Array.isArray(opBody.providers)).toBe(true);
	expect(opBody.providers).toEqual([{ id: "openai", transport: "webrtc", model: "gpt-realtime-2.1" }]);

	const adminRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer admin-tok" } });
	expect(adminRes.status).toBe(200);
	expect((await adminRes.json()).providers).toBeDefined();
});

test("MEDIUM-4: GET /api/voice/config reports {enabled:false} — not {enabled:true, providers:[]} — when no provider key is configured at all", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	delete process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY;
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok" } });
	const res = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer op-tok" } });
	expect(res.status).toBe(200);
	// The config probe is the one honest discovery channel: POST /api/voice/token would 501 for
	// EVERY provider right now (none has a key), so the probe must not show a button that dies at
	// the first mint attempt — {enabled:true, providers:[]} would still render a (dead) button.
	expect(await res.json()).toEqual({ enabled: false });
});

test("MEDIUM-4, flipped deliberately (concern 03): DB mode reports {enabled:false} for an org with NO configured row, even with an operator env key set — and never falls back to it", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-operator-env-key"; // must never leak into a DB-mode mint
	const { url } = await startDbModeServer(["orgC"], { userC: { id: "user-c", orgId: "orgC", role: "member" } });
	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { cookie: "session=userC" } });
	expect(cfgRes.status).toBe(200);
	// The old premise (single shared key, no per-org attribution) is gone: this is now a per-org
	// signal, not a mode-wide one — {enabled:false} here means "this ORG has no key", not "DB mode
	// can never mint".
	expect(await cfgRes.json()).toEqual({ enabled: false });
	const tracker = countOpenAiMintCalls();
	const mintRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userC" } });
	// A per-org refusal falls out of the ordinary "no key configured" 501 — the SAME path file mode
	// has always used — not the old mode-wide 403.
	expect(mintRes.status).toBe(501);
	expect(tracker.calls()).toBe(0); // never even attempted the mint — the env key was never consulted
});

test("MEDIUM-4: GET /api/voice/config reports {enabled:true, providers:[...]} in file mode with a real key configured (the happy path is unaffected)", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok" } });
	const res = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer op-tok" } });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.enabled).toBe(true);
	expect(body.providers).toEqual([{ id: "openai", transport: "webrtc", model: "gpt-realtime-2.1" }]);
});

test("MEDIUM-4, rewritten (concern 03): voiceKeyFor/orgHasKey in file mode are false with no key configured, true once one is", async () => {
	delete process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY;
	expect(await orgHasKey({ mode: "file" })).toBe(false);
	expect(await voiceKeyFor({ mode: "file" }, "openai")).toBeUndefined();
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	expect(await orgHasKey({ mode: "file" })).toBe(true);
	expect(await voiceKeyFor({ mode: "file" }, "openai")).toBe("sk-test");
});

test("voiceKeyFor: file mode reads the keyed env var byte-for-byte unchanged (trims exactly like the pre-concern-03 reader did)", async () => {
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "  sk-padded-file-mode-key\n";
	expect(await voiceKeyFor({ mode: "file" }, "openai")).toBe("sk-padded-file-mode-key");
});

test("cross-tenant mint isolation: org A mints with A's key, org B with B's — never the other's (THE load-bearing pin)", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	const { url, ctx } = await startDbModeServer(["orgA", "orgB"], {
		userA: { id: "user-a", orgId: "orgA", role: "member" },
		userB: { id: "user-b", orgId: "orgB", role: "member" },
	});
	await putOrgSecret(ctx, "orgA", "openai", "sk-org-a-key", "db:user-a");
	await putOrgSecret(ctx, "orgB", "openai", "sk-org-b-key", "db:user-b");

	const capturedAuth: string[] = [];
	let mintN = 0;
	mockOpenAiMint((_body, headers) => {
		capturedAuth.push(headers.get("authorization") ?? "");
		mintN++;
		return { status: 200, json: { value: `ek_${mintN}`, expires_at: 1, session: {} } };
	});

	const mintAs = (session: string) => fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: `session=${session}` } });

	const resA = await mintAs("userA");
	expect(resA.status).toBe(200);
	const resB = await mintAs("userB");
	expect(resB.status).toBe(200);

	// The Authorization header the daemon actually sent upstream is the only place this is provable:
	// org A's session must have minted with A's key, org B's with B's — never crossed.
	expect(capturedAuth).toEqual(["Bearer sk-org-a-key", "Bearer sk-org-b-key"]);
});

test("DB mode: GET /api/voice/config reports {enabled:true, providers:[...]} and mint succeeds once the session org has a configured, enabled key (the DB-mode happy path)", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	const { url, ctx } = await startDbModeServer(["orgD"], { userD: { id: "user-d", orgId: "orgD", role: "member" } });
	await putOrgSecret(ctx, "orgD", "openai", "sk-org-d-key", "db:user-d");
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_org_d", expires_at: 1, session: {} } }));

	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { cookie: "session=userD" } });
	expect(cfgRes.status).toBe(200);
	expect(await cfgRes.json()).toEqual({ enabled: true, providers: [{ id: "openai", transport: "webrtc", model: "gpt-realtime-2.1" }] });

	const mintRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userD" } });
	expect(mintRes.status).toBe(200);
});

test("DB mode: disabling the org's key (kill switch) flips {enabled:false} and refuses mint, without deleting the row", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	const { url, ctx } = await startDbModeServer(["orgE"], { userE: { id: "user-e", orgId: "orgE", role: "member" } });
	await putOrgSecret(ctx, "orgE", "openai", "sk-org-e-key", "db:user-e");
	await setOrgSecretEnabled(ctx, "orgE", "openai", false, "db:admin-e");

	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { cookie: "session=userE" } });
	expect(await cfgRes.json()).toEqual({ enabled: false });

	const tracker = countOpenAiMintCalls();
	const mintRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userE" } });
	expect(mintRes.status).toBe(501);
	expect(tracker.calls()).toBe(0);
});

test("DB mode: decrypt-fails-closed propagates through the resolver — a corrupted row reads as {enabled:false} and mint 501s, never a 500", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	const { url, ctx, handle } = await startDbModeServer(["orgF"], { userF: { id: "user-f", orgId: "orgF", role: "member" } });
	await putOrgSecret(ctx, "orgF", "openai", "sk-org-f-key", "db:user-f");
	await handle.db.updateTable("org_secret").set({ ciphertext: "not-valid-base64-ciphertext!!" }).where("org_id", "=", "orgF").execute();

	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { cookie: "session=userF" } });
	expect(cfgRes.status).toBe(200);
	expect(await cfgRes.json()).toEqual({ enabled: false });

	const mintRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=userF" } });
	expect(mintRes.status).toBe(501);
});

test("DB mode: a session with no active org (viewer tier) gets {enabled:false} from the config probe — a clean refusal, never a throw", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-operator-env-key"; // must not leak through either
	const { url } = await startDbModeServer([], { userG: { id: "user-g" } }); // no orgId ⇒ no active org
	const res = await fetch(`${url}/api/voice/config`, { headers: { cookie: "session=userG" } });
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ enabled: false });
});

test("DB mode: a bootstrap-admin loopback session with no active org gets a clean mint refusal — never a throw, never the env key", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-operator-env-key";
	const { url } = await startDbModeServer([], {}, { token: "admin-tok" });
	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer admin-tok" } });
	expect(cfgRes.status).toBe(200);
	expect(await cfgRes.json()).toEqual({ enabled: false });
	const tracker = countOpenAiMintCalls();
	const mintRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	expect(mintRes.status).toBe(501);
	expect(tracker.calls()).toBe(0);
});

test("root-factory org gets no bypass: the sentinel org id resolves like any other — no row, no key, even with an operator env key set", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-operator-env-key";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-root-factory-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const handle = await openDatabase();
	if (!handle) throw new Error("openDatabase returned null in DB mode");
	try {
		const ctx: OrgContext = { db: handle.db, type: handle.type };
		const scope: VoiceKeyScope = { mode: "db", ctx, orgId: ROOT_FACTORY_ORG };
		expect(await voiceKeyFor(scope, "openai")).toBeUndefined();
		expect(await orgHasKey(scope)).toBe(false);
	} finally {
		await handle.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("probe/mint agreement: orgHasKey and voiceKeyFor never disagree, for every (mode, org, key-state) scope", async () => {
	initMasterKey({ OMP_SQUAD_SECRETS_KEY: KEY_HEX });
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-agreement-"));
	process.env.DATABASE_URL = `sqlite:${path.join(dir, "app.sqlite")}`;
	const handle = await openDatabase();
	if (!handle) throw new Error("openDatabase returned null in DB mode");
	try {
		const ctx: OrgContext = { db: handle.db, type: handle.type };
		await handle.db.insertInto("organization").values({ id: "orgH", name: "Org H", slug: "org-h", createdAt: new Date().toISOString() }).execute();
		await putOrgSecret(ctx, "orgH", "openai", "sk-org-h", "db:user-h");
		process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-file-mode-key";

		const scopes: Array<{ label: string; scope: VoiceKeyScope }> = [
			{ label: "file mode, env key set", scope: { mode: "file" } },
			{ label: "db mode, org with an enabled key", scope: { mode: "db", ctx, orgId: "orgH" } },
			{ label: "db mode, org with no row", scope: { mode: "db", ctx, orgId: "orgI" } },
			{ label: "db mode, no active org", scope: { mode: "db", ctx, orgId: undefined } },
			{ label: "db mode, no db handle wired (a broken boot)", scope: { mode: "db", ctx: undefined, orgId: "orgH" } },
		];
		for (const { label, scope } of scopes) {
			const has = await orgHasKey(scope);
			const resolved = await voiceKeyFor(scope, "openai");
			if (has !== !!resolved) throw new Error(`orgHasKey (${has}) vs voiceKeyFor (${!!resolved}) disagree for: ${label}`);
		}

		await setOrgSecretEnabled(ctx, "orgH", "openai", false, "db:admin-h");
		const disabledScope: VoiceKeyScope = { mode: "db", ctx, orgId: "orgH" };
		expect(await orgHasKey(disabledScope)).toBe(false);
		expect(await voiceKeyFor(disabledScope, "openai")).toBeUndefined();
	} finally {
		await handle.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("unknown provider 400s at the HTTP layer with zero fetch calls to any provider mint endpoint", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	const tracker = countOpenAiMintCalls();
	const { url } = await startServer({ token: "admin-tok" });
	const res = await fetch(`${url}/api/voice/token`, {
		method: "POST",
		headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
		body: JSON.stringify({ provider: "xai" }),
	});
	expect(res.status).toBe(400);
	expect(tracker.calls()).toBe(0);
});

test("concern-audit finding 2: malformed JSON body 400s BEFORE any mint, instead of silently minting a default-provider token", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	const tracker = countOpenAiMintCalls();
	const { url } = await startServer({ token: "admin-tok" });
	const res = await fetch(`${url}/api/voice/token`, {
		method: "POST",
		headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
		body: "{ this is not valid json",
	});
	expect(res.status).toBe(400);
	expect(tracker.calls()).toBe(0);
});

test("concern-audit finding 2: a valid-JSON-but-non-object body (e.g. a bare array) also 400s rather than defaulting", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	const tracker = countOpenAiMintCalls();
	const { url } = await startServer({ token: "admin-tok" });
	const res = await fetch(`${url}/api/voice/token`, {
		method: "POST",
		headers: { authorization: "Bearer admin-tok", "content-type": "application/json" },
		body: JSON.stringify(["not", "an", "object"]),
	});
	expect(res.status).toBe(400);
	expect(tracker.calls()).toBe(0);
});

test("concern-audit finding 2: a truly empty body (nothing sent) still mints — defaulting to openai is the intentionally-lenient case", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_empty_body_ok", expires_at: 1, session: {} } }));
	const { url } = await startServer({ token: "admin-tok" });
	const res = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } }); // no body at all
	expect(res.status).toBe(200);
	expect((await res.json()).provider).toBe("openai");
});

test("concern-audit finding 4: a newline/space-padded provider key is trimmed at mint — config and mint agree instead of config advertising enabled while every mint 502s", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "  sk-padded-key\n"; // padded exactly like the untrimmed-env footgun
	let capturedAuth: string | undefined;
	mockOpenAiMint((_body) => ({ status: 200, json: { value: "ek_trimmed", expires_at: 1, session: {} } }));
	const realFetchForAuthCapture = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url === OPENAI_MINT_URL) capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
		return realFetchForAuthCapture(input as never, init);
	}) as typeof fetch;
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok" } });
	// GET /api/voice/config must honestly advertise enabled:true for this (trimmed) key.
	const cfgRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer op-tok" } });
	expect((await cfgRes.json()).enabled).toBe(true);
	// And the mint itself must actually succeed with the SAME trimmed key, not 502 on the padded raw value.
	const mintRes = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	expect(mintRes.status).toBe(200);
	expect(capturedAuth).toBe("Bearer sk-padded-key");
});

test("per-actor mint rate cap 429s after the configured burst (feedbackRateAllowed shape)", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN = "2";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_burst", expires_at: 1, session: {} } }));
	const { url } = await startServer({ token: "admin-tok" });
	const hit = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	expect((await hit()).status).toBe(200);
	expect((await hit()).status).toBe(200);
	expect((await hit()).status).toBe(429);
});

test("concern-audit finding 1: OMP_SQUAD_VOICE_MINT_RATE_PER_MIN=0 does NOT disable the cap — it falls back to the default (6) and still 429s on burst", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN = "0"; // the footgun value: absence-as-success would read this as "unlimited"
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_zero_cap", expires_at: 1, session: {} } }));
	const { url } = await startServer({ token: "admin-tok" });
	const hit = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	for (let i = 0; i < 6; i++) expect((await hit()).status).toBe(200); // default cap of 6, not unlimited
	expect((await hit()).status).toBe(429); // the 7th must be refused — a true "unlimited" reading would keep returning 200
});

test("concern-audit finding 1: a negative OMP_SQUAD_VOICE_MINT_RATE_PER_MIN also falls back to the default rather than disabling the cap", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN = "-3";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_neg_cap", expires_at: 1, session: {} } }));
	const { url } = await startServer({ token: "admin-tok" });
	const hit = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	for (let i = 0; i < 6; i++) expect((await hit()).status).toBe(200);
	expect((await hit()).status).toBe(429);
});

test("rate cap buckets are per-actor: operator and admin tokens don't share a bucket", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_x", expires_at: 1, session: {} } }));
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok" } });
	const hitAsAdmin = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
	const hitAsOperator = () => fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer op-tok" } });
	expect((await hitAsAdmin()).status).toBe(200); // admin bucket, 1st
	expect((await hitAsOperator()).status).toBe(200); // separate operator bucket, 1st — not blocked by admin's cap
	expect((await hitAsAdmin()).status).toBe(429); // admin bucket, 2nd — over its own cap of 1
});

test("a successful mint never logs the ek_ value or the raw provider response", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 200, json: { value: "ek_supersecret_do_not_log", expires_at: 42, session: { id: "sess_should_not_log" } } }));
	const logSpy = spyOn(console, "log").mockImplementation(() => {});
	const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
	const errSpy = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { url } = await startServer({ token: "admin-tok" });
		const res = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.value).toBe("ek_supersecret_do_not_log");
		const flattened = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls]
			.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
			.join("\n");
		expect(flattened).not.toContain("ek_supersecret_do_not_log");
		expect(flattened).not.toContain("sess_should_not_log");
	} finally {
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errSpy.mockRestore();
	}
});

test("a failed upstream mint never logs the raw provider error body either", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	mockOpenAiMint(() => ({ status: 401, json: { error: { message: "invalid_api_key-should-not-log" } } }));
	const errSpy = spyOn(console, "error").mockImplementation(() => {});
	const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const { url } = await startServer({ token: "admin-tok" });
		const res = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { authorization: "Bearer admin-tok" } });
		expect(res.status).toBe(502);
		const flattened = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
		expect(flattened).not.toContain("invalid_api_key-should-not-log");
	} finally {
		errSpy.mockRestore();
		warnSpy.mockRestore();
	}
});
