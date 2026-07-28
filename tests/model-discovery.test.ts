/**
 * Cold per-harness model discovery (src/model-discovery.ts) — driven against FAKE harness CLIs.
 *
 * Production symptom this covers (2026-07-28): the create-agent model dropdown showed a section per
 * harness, each containing ONLY "<harness> default" — because `/api/models` had no cold path to a
 * harness's real roster until an agent of that harness happened to be live. These tests prove both
 * probe dialects (omp-rpc `get_available_models`, ACP `initialize`→`session/new`) against fake CLIs
 * (no real binary, account, or tokens — the same discipline as acp-agent-driver.test.ts), the
 * bounded-timeout degradation (static catalog / empty, never a hang), the cache + single-flight
 * behavior, and the `/api/models` wiring through a real SquadServer with discovery DISARMED (the
 * armed bit is cmdUp-only precisely so no test ever spawns a genuine harness CLI).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { modelOptionsFromRuntime } from "../src/agent-profiles.ts";
import { FileStore } from "../src/dal/store.ts";
import type { CapabilityDescriptor, HarnessDescriptor } from "../src/harness-registry.ts";
import { _resetModelDiscoveryForTests, _seedModelDiscoveryForTests, discoveredModelOptions, discoverHarnessModels, ensureHarnessModels } from "../src/model-discovery.ts";
import { mergeModelOptions, modelOptionsFromEnv, harnessDefaultModelOptions, sortModelOptionsForPicker, SquadServer } from "../src/server.ts";
import { SquadManager } from "../src/squad-manager.ts";

const CAPS: CapabilityDescriptor = { hostTools: false, toolApproval: "none", resumable: false, modelSwitch: false, thinking: false, contextInjection: "none" };

function rpcDescriptor(name: string, staticModels?: string[]): HarnessDescriptor {
	return { name, protocol: "omp-rpc", bin: name, capabilities: CAPS, verified: false, staticModels };
}

function acpDescriptor(name: string, staticModels?: string[]): HarnessDescriptor {
	return { name, protocol: "acp", bin: name, acpCommand: [name], capabilities: CAPS, verified: false, staticModels };
}

/** An omp-rpc-dialect fake: emits a ready frame + non-JSON log noise, answers get_available_models
 *  with the RPC response framing (payload under `data`), and appends one marker line per launch to
 *  argv[2] when given — the spawn counter the cache tests read. */
const FAKE_RPC = String.raw`
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (process.argv[2]) require("node:fs").appendFileSync(process.argv[2], "spawn\n");
send({ type: "ready" });
process.stdout.write("interleaved log noise, deliberately not JSON\n");
let buf = "";
process.stdin.on("data", (ch) => {
  buf += ch;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "get_available_models") {
      send({ type: "response", id: msg.id, command: "get_available_models", success: true, data: { models: [
        { id: "claude-opus-4-5", provider: "anthropic", name: "Claude Opus 4.5" },
        { id: "gpt-5.2", provider: "openai" },
        { id: "claude-opus-4-5", provider: "anthropic" },
      ] } });
    }
  }
});
`;

/** Accepts the command and never answers — the probe must time out and kill it, never hang. */
const FAKE_RPC_HANG = String.raw`
if (process.argv[2]) require("node:fs").appendFileSync(process.argv[2], "spawn\n");
process.stdin.on("data", () => {});
`;

/** An ACP-dialect fake: initialize → session/new advertising models.availableModels (the modelId/
 *  name shape every live-verified ACP harness returns). */
const FAKE_ACP_MODELS = String.raw`
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", (ch) => {
  buf += ch;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", models: { currentModelId: "m-default", availableModels: [
      { modelId: "m-default", name: "Model Default" },
      { modelId: "m-fast", name: "Model Fast", description: "quick" },
    ] } } });
  }
});
`;

/** initialize succeeds, session/new fails — the live claude-code nested-session refusal shape. */
const FAKE_ACP_SESSION_ERROR = String.raw`
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", (ch) => {
  buf += ch;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
    if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Query closed before response received" } });
  }
});
`;

const tmps: string[] = [];
afterEach(async () => {
	_resetModelDiscoveryForTests();
	for (const dir of tmps.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function fakeCli(source: string): Promise<{ script: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-disc-"));
	tmps.push(dir);
	const script = path.join(dir, "fake-cli.ts");
	await fs.writeFile(script, source);
	return { script, dir };
}

const probeEnv = { PATH: process.env.PATH ?? "" };

test("omp-rpc cold probe: get_available_models over stdio → live-probe options in the manager's exact value shape (provider/id), deduped, harness-tagged", async () => {
	const { script, dir } = await fakeCli(FAKE_RPC);
	const result = await discoverHarnessModels(rpcDescriptor("fake-rpc"), { argv: [process.execPath, script], env: probeEnv, cwd: dir, timeoutMs: 15_000 });
	expect(result.provenance).toBe("live-probe");
	expect(result.error).toBeUndefined();
	// Same mapper as manager.modelOptions() (modelOptionsFromRuntime): provider-namespaced value,
	// in-list duplicate collapsed — a cold answer and a live answer for one harness are byte-compatible.
	expect(result.models.map((m) => m.value)).toEqual(["anthropic/claude-opus-4-5", "openai/gpt-5.2"]);
	for (const m of result.models) {
		expect(m.harness).toBe("fake-rpc");
		expect(m.provenance).toBe("live-probe");
	}
}, 30_000);

test("a hung omp-rpc probe times out within its budget and degrades to the registry's static catalog — provenance says so, and the error is kept", async () => {
	const { script, dir } = await fakeCli(FAKE_RPC_HANG);
	const started = Date.now();
	const result = await discoverHarnessModels(rpcDescriptor("fake-hang", ["catalog-a", "catalog-b"]), { argv: [process.execPath, script], env: probeEnv, cwd: dir, timeoutMs: 400 });
	expect(Date.now() - started).toBeLessThan(5_000); // bounded — degrade, never hang
	expect(result.provenance).toBe("static-catalog");
	expect(result.error).toMatch(/timed out/);
	expect(result.models.map((m) => m.value)).toEqual(["catalog-a", "catalog-b"]);
	for (const m of result.models) expect(m.provenance).toBe("static-catalog");
}, 30_000);

test("a failed probe with NO static catalog yields an empty roster — the picker then still shows the harness's default entry, so failure means default-only", async () => {
	const { script, dir } = await fakeCli(FAKE_RPC_HANG);
	const result = await discoverHarnessModels(rpcDescriptor("fake-hang-bare"), { argv: [process.execPath, script], env: probeEnv, cwd: dir, timeoutMs: 400 });
	expect(result.models).toEqual([]);
	expect(result.error).toMatch(/timed out/);
}, 30_000);

test("ACP cold probe: initialize → session/new → models.availableModels, mapped through the same runtime mapper (modelId dialect)", async () => {
	const { script, dir } = await fakeCli(FAKE_ACP_MODELS);
	const result = await discoverHarnessModels(acpDescriptor("fake-acp"), { argv: [process.execPath, script], env: probeEnv, cwd: dir, timeoutMs: 15_000 });
	expect(result.provenance).toBe("live-probe");
	expect(result.models.map((m) => m.value)).toEqual(["m-default", "m-fast"]);
	expect(result.models[0]?.harness).toBe("fake-acp");
}, 30_000);

test("an ACP handshake that fails at session/new (the live nested-session refusal shape) degrades to the static catalog with the server's own error kept", async () => {
	const { script, dir } = await fakeCli(FAKE_ACP_SESSION_ERROR);
	const result = await discoverHarnessModels(acpDescriptor("fake-acp-err", ["default", "sonnet"]), { argv: [process.execPath, script], env: probeEnv, cwd: dir, timeoutMs: 15_000 });
	expect(result.provenance).toBe("static-catalog");
	expect(result.error).toContain("Query closed before response received");
	expect(result.models.map((m) => m.value)).toEqual(["default", "sonnet"]);
}, 30_000);

test("an ACP adapter that dies at spawn fails FAST (stream-down, not the full probe budget) and still degrades to the catalog", async () => {
	const { script, dir } = await fakeCli(`process.exit(1);`);
	const started = Date.now();
	const result = await discoverHarnessModels(acpDescriptor("fake-acp-dead", ["only"]), { argv: [process.execPath, script], env: probeEnv, cwd: dir, timeoutMs: 20_000 });
	expect(Date.now() - started).toBeLessThan(10_000); // far under the 20s budget — the exit itself failed the probe
	expect(result.provenance).toBe("static-catalog");
	expect(result.error).toMatch(/exited before answering/);
	expect(result.models.map((m) => m.value)).toEqual(["only"]);
}, 30_000);

test("ensureHarnessModels is single-flight and TTL-cached: concurrent + repeat callers share ONE probe; an expired TTL re-probes", async () => {
	const { script, dir } = await fakeCli(FAKE_RPC);
	const counter = path.join(dir, "spawns");
	const opts = { argv: [process.execPath, script, counter], env: probeEnv, cwd: dir, timeoutMs: 15_000 };
	const d = rpcDescriptor("fake-cached");
	const [a, b] = await Promise.all([ensureHarnessModels(d, opts), ensureHarnessModels(d, opts)]);
	expect(a.models.length).toBeGreaterThan(0);
	expect(b).toEqual(a);
	await ensureHarnessModels(d, opts); // within TTL — served from cache
	expect((await fs.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
	await ensureHarnessModels(d, { ...opts, ttlMs: 0 }); // expired — a real second probe
	expect((await fs.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(2);
}, 30_000);

test("a cached FAILURE is served during its retry window (no hammering a broken binary), and retried once the window passes", async () => {
	const { script, dir } = await fakeCli(FAKE_RPC_HANG);
	const counter = path.join(dir, "spawns");
	const opts = { argv: [process.execPath, script, counter], env: probeEnv, cwd: dir, timeoutMs: 300 };
	const d = rpcDescriptor("fake-fail-cache");
	const first = await ensureHarnessModels(d, opts);
	expect(first.error).toMatch(/timed out/);
	await ensureHarnessModels(d, opts); // default 60s failure window — cached, no new spawn
	expect((await fs.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
	await ensureHarnessModels(d, { ...opts, failureRetryMs: 0 }); // window over — retried
	expect((await fs.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(2);
}, 30_000);

test("discoveredModelOptions while DISARMED is a pure cache read — seeded results surface, nothing spawns (the armed bit is cmdUp-only by design)", async () => {
	// omp is this repo's own devDependency, so it is always in the detected roster here — the seeded
	// harness must be a real detected one for collection to pick it up, exactly like production.
	_seedModelDiscoveryForTests({
		harness: "omp",
		provenance: "live-probe",
		at: Date.now(),
		models: [{ label: "anthropic/claude-opus-4-5", value: "anthropic/claude-opus-4-5", harness: "omp", provenance: "live-probe" }],
	});
	const options = await discoveredModelOptions(0);
	expect(options.map((o) => o.value)).toEqual(["anthropic/claude-opus-4-5"]);
});

test("sortModelOptionsForPicker: each harness's entries end up CONTIGUOUS (the picker headings render per group CHANGE), harness-less entries first, in-group order preserved", () => {
	const sorted = sortModelOptionsForPicker([
		{ label: "omp default", value: "", harness: "omp" },
		{ label: "pi default", value: "", harness: "pi" },
		{ label: "env-model", value: "env-model" },
		{ label: "anthropic/claude-opus-4-5", value: "anthropic/claude-opus-4-5", harness: "omp" },
		{ label: "google/gemini-3-pro", value: "google/gemini-3-pro", harness: "pi" },
	]);
	expect(sorted.map((o) => o.harness ?? "")).toEqual(["", "omp", "omp", "pi", "pi"]);
	// Within a group the merge order survives: the blank-value default entry stays the section's first row.
	expect(sorted.filter((o) => o.harness === "omp").map((o) => o.value)).toEqual(["", "anthropic/claude-opus-4-5"]);
});

test("modelOptionsFromRuntime reads ACP's modelId dialect alongside RPC's id/provider — one mapper, identical option values from either wire", () => {
	const options = modelOptionsFromRuntime([
		{ id: "claude-opus-4-5", provider: "anthropic" },
		{ modelId: "m-default", name: "Model Default" },
		{ id: "wins", modelId: "loses" }, // id takes precedence when both appear
	]);
	expect(options.map((o) => o.value)).toEqual(["anthropic/claude-opus-4-5", "m-default", "wins"]);
});

// ── /api/models wiring, through a REAL SquadServer (harnesses-route.test.ts's fixture discipline) ──

test("GET /api/models surfaces cached cold-discovered models beside the per-harness default, provenance intact, harness sections contiguous — with discovery disarmed (no CLI ever spawns in tests)", async () => {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "model-disc-route-"));
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state), skipGlobalJanitors: true });
	const server = new SquadServer(manager, { port: 0, token: "admin-token-xxxxxxxx" });
	const url = server.start();
	try {
		_seedModelDiscoveryForTests({
			harness: "omp",
			provenance: "live-probe",
			at: Date.now(),
			models: [{ label: "anthropic/claude-opus-4-5", value: "anthropic/claude-opus-4-5", harness: "omp", provenance: "live-probe" }],
		});
		const res = await fetch(`${url}/api/models`, { headers: { authorization: "Bearer admin-token-xxxxxxxx" } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { models: Array<{ label: string; value: string; harness?: string; provenance?: string }> };
		const omp = body.models.filter((m) => m.harness === "omp");
		// The default placeholder AND the discovered model — additive, exactly like live answers merge.
		expect(omp.map((m) => m.value)).toEqual(["", "anthropic/claude-opus-4-5"]);
		expect(omp[1]?.provenance).toBe("live-probe");
		// Contiguity across the whole payload: a harness's section never renders twice.
		const groups = body.models.map((m) => m.harness ?? "");
		const seen = new Set<string>();
		for (let i = 0; i < groups.length; i++) {
			if (i > 0 && groups[i] === groups[i - 1]) continue;
			expect(seen.has(groups[i]!)).toBe(false);
			seen.add(groups[i]!);
		}
	} finally {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
	}
}, 30_000);

test("the merge pipeline never loses the env-configured models or the untagged legacy bucket when discovery contributes", () => {
	const merged = sortModelOptionsForPicker(
		mergeModelOptions(
			modelOptionsFromEnv({ OMP_SQUAD_MODELS: "custom-model" } as NodeJS.ProcessEnv),
			harnessDefaultModelOptions(),
			[{ label: "anthropic/claude-opus-4-5", value: "anthropic/claude-opus-4-5", harness: "omp", provenance: "live-probe" }],
		),
	);
	expect(merged.find((m) => m.value === "custom-model" && !m.harness)).toBeDefined();
	expect(merged.find((m) => m.value === "anthropic/claude-opus-4-5" && m.harness === "omp")).toBeDefined();
	expect(merged.find((m) => m.value === "" && m.harness === "omp")).toBeDefined();
});
