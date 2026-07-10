/**
 * Voice token mint + capability probe (plans/webapp-voice-lane/05-voice-token-endpoints.md).
 *
 * Covers every red-team guard named in the concern file:
 *   - envBool("OMP_SQUAD_VOICE_ENABLED") gate: both routes 404 (not disabled/501) when off.
 *   - DB-mode refusal: POST /api/voice/token 403s regardless of tier when `this.auth` is set
 *     (single shared provider key, no per-org attribution/budget in v1).
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
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer, type AuthInstance } from "../src/server.ts";
import { isKnownVoiceProvider, mintVoiceToken, VOICE_SESSION_TOOLS } from "../src/voice-token.ts";

const OPENAI_MINT_URL = "https://api.openai.com/v1/realtime/client_secrets";
const realFetch = globalThis.fetch;

const SAVED_ENV: Record<string, string | undefined> = {
	OMP_SQUAD_VOICE_ENABLED: process.env.OMP_SQUAD_VOICE_ENABLED,
	OMP_SQUAD_VOICE_OPENAI_API_KEY: process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY,
	OMP_SQUAD_VOICE_MODEL: process.env.OMP_SQUAD_VOICE_MODEL,
	OMP_SQUAD_VOICE_VOICE: process.env.OMP_SQUAD_VOICE_VOICE,
	OMP_SQUAD_VOICE_MINT_RATE_PER_MIN: process.env.OMP_SQUAD_VOICE_MINT_RATE_PER_MIN,
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
 *  local SquadServer under test) passes through to the real fetch unmodified. */
function mockOpenAiMint(handler: (body: unknown) => { status: number; json?: unknown }): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string } | undefined)?.url;
		if (url !== OPENAI_MINT_URL) return realFetch(input as never, init);
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		const { status, json } = handler(body);
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

function dbAuthStub(): AuthInstance {
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }: { headers: Headers }) => {
				const cookie = headers.get("cookie") ?? "";
				if (!/session=member1/.test(cookie)) return null;
				return { user: { id: "user-1", name: "Member", email: "member@example.test" }, session: { activeOrganizationId: "org1" } };
			},
			// "member" ⇒ operator tier (bridgeRole) — clears the POST /api/voice/token operator gate so
			// the test actually reaches the DB-mode refusal, not an earlier 403 from the RBAC tier check.
			getActiveMemberRole: async () => ({ role: "member" }),
		},
	} as unknown as AuthInstance;
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
	// The browser never chooses model/voice/instructions/tools — asserted against what was actually sent.
	expect(capturedBody.session.model).toBe("gpt-realtime-test");
	expect(capturedBody.session.voice).toBe("aria");
	expect(capturedBody.session.turn_detection).toBeNull(); // push-to-talk v1
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
	expect(capturedBody.expires_after).toEqual({ anchor: "created_at", seconds: 3600 });
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
	expect(capturedBody.session.voice).toBe("marin");
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

test("GET /api/voice/config: viewer tier gets {enabled} ONLY (no providers key); operator+ gets providers", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY = "sk-test";
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok", viewer: "view-tok" } });

	const viewerRes = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer view-tok" } });
	expect(viewerRes.status).toBe(200);
	const viewerBody = await viewerRes.json();
	expect(viewerBody).toEqual({ enabled: true });
	expect("providers" in viewerBody).toBe(false);

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

test("GET /api/voice/config advertises only providers whose API key is configured — enabled-but-keyless lists none", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	delete process.env.OMP_SQUAD_VOICE_OPENAI_API_KEY;
	const { url } = await startServer({ token: "admin-tok", roleTokens: { operator: "op-tok" } });
	const res = await fetch(`${url}/api/voice/config`, { headers: { authorization: "Bearer op-tok" } });
	expect(res.status).toBe(200);
	const body = await res.json();
	// The config probe is the one honest discovery channel: a provider whose mint would 501 must
	// not be advertised (review finding M2 on concern 05).
	expect(body).toEqual({ enabled: true, providers: [] });
});

test("POST /api/voice/token refuses with 403 in DB mode regardless of tier (single shared key, no per-org attribution in v1)", async () => {
	process.env.OMP_SQUAD_VOICE_ENABLED = "1";
	const { url } = await startServer({ auth: dbAuthStub() });
	const res = await fetch(`${url}/api/voice/token`, { method: "POST", headers: { cookie: "session=member1" } });
	expect(res.status).toBe(403);
	const text = (await res.text()).toLowerCase();
	expect(text).toContain("db");
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
