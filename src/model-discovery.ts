/**
 * Cold per-harness model discovery — the answer to "what models can this harness run?" WITHOUT a
 * live agent connected.
 *
 * `manager.modelOptions()` can only ask a harness that already has a LIVE agent (a chicken-and-egg
 * gap at the exact moment the create-agent surface needs an answer), and the static
 * `harnessDefaultModelOptions()` fallback that shipped for it only produces one "<harness> default"
 * placeholder per harness — which is exactly what the production dropdown then showed (2026-07-28):
 * four sections, each containing nothing but its own name.
 *
 * This module asks each harness the way its OWN ecosystem answers, using the SAME channel the live
 * driver would use — so the cold answer and the live answer can never drift apart in shape:
 *
 *  - `omp-rpc` harnesses (omp, pi): spawn `<bin> --mode rpc --no-session` with a scrubbed env, send
 *    the `get_available_models` RPC command (the very frame RpcAgent.getAvailableModels sends), read
 *    the one response, kill the child. Live-verified 2026-07-28: omp v17.1.8 answers 41 models in
 *    ~2.3s, pi v0.56.3 answers 23 in ~1.4s — both accept the command immediately, no ready-wait
 *    needed (pi never emits a ready frame at all; see `emitsReadyFrame`).
 *  - `acp` harnesses (opencode, claude-code, grok, …): spawn the registry's `acpCommand`, run the
 *    JSON-RPC `initialize` → `session/new` handshake (the same one AcpAgentDriver.start performs),
 *    and read `models.availableModels` from the session/new result — ACP's only model-listing
 *    channel. Live-verified 2026-07-28: grok v0.2.x answers in ~0.5s, the claude-code npx adapter in
 *    ~8s, opencode v1.1.x in ~17s (hence the generous probe timeout and the cache below).
 *
 * Probes are bounded (per-probe timeout, child always killed), cached (success TTL + shorter failure
 * retry), and single-flight per harness. A probe that fails degrades to the harness's declared
 * `staticModels` catalog when one exists (provenance `"static-catalog"`, honestly labelled), else to
 * an empty list — the picker then still shows the harness's default entry, so failure means
 * "default only", never a hang and never a missing section.
 *
 * DISABLED unless `enableModelDiscovery()` ran (cmdUp calls it at real daemon boot, mirroring
 * `applyWellKnownDirsToProcessPath`'s boot-only discipline): a unit test constructing a
 * SquadServer must never find this module spawning genuine harness CLIs behind `/api/models`.
 * `discoveredModelOptions` still READS the cache while disabled, so tests can seed it.
 */

import * as os from "node:os";
import { modelOptionsFromRuntime, type RuntimeModelOption } from "./agent-profiles.ts";
import { envBool, envInt } from "./config.ts";
import { errText } from "./err-text.ts";
import { type HarnessDescriptor, listHarnesses, listHarnessTiers, resolveAcpCommand, resolveBin, resolveHarnessBinPath } from "./harness-registry.ts";
import { harnessAuthEnv, scrubbedSpawnEnv } from "./spawn-env.ts";

/** Where a discovered model entry's knowledge comes from — carried on every option so the create
 *  surface (and anyone debugging it) can tell a live-probed roster from a baked-in catalog. */
export type ModelProvenance = "live-probe" | "static-catalog";

export interface DiscoveredModelOption extends RuntimeModelOption {
	provenance: ModelProvenance;
}

export interface HarnessModelDiscovery {
	harness: string;
	provenance: ModelProvenance;
	models: DiscoveredModelOption[];
	/** When this answer was produced (cache bookkeeping). */
	at: number;
	/** Set when the probe failed — `models` is then the static catalog (possibly empty), and this is
	 *  the honest reason why. */
	error?: string;
}

export interface ProbeOptions {
	/** Override the spawned argv (tests inject a fake CLI script; production derives it from the
	 *  registry descriptor). */
	argv?: string[];
	/** Hard per-probe budget. Default `OMP_SQUAD_MODEL_PROBE_TIMEOUT_MS` (45s — opencode's live
	 *  session/new alone takes ~17s, and the claude-code npx adapter needs >30s when five probes
	 *  cold-start concurrently at boot warm; live-measured 2026-07-28). A cap, not a wait —
	 *  `/api/models` blocks at most `OMP_SQUAD_MODEL_DISCOVERY_WAIT_MS`; a straggler's answer lands
	 *  in the cache for the next fetch. The child is killed either way. */
	timeoutMs?: number;
	/** Success-result freshness. Default `OMP_SQUAD_MODEL_DISCOVERY_TTL_MS` (10 min). */
	ttlMs?: number;
	/** How soon a FAILED probe may be retried (fixed 60s unless injected) — long enough not to
	 *  hammer a broken binary on every poll, short enough that fixing a login shows up in a minute. */
	failureRetryMs?: number;
	env?: Record<string, string>;
	cwd?: string;
}

function probeTimeoutMs(): number {
	return envInt("OMP_SQUAD_MODEL_PROBE_TIMEOUT_MS", 45_000);
}

function successTtlMs(): number {
	return envInt("OMP_SQUAD_MODEL_DISCOVERY_TTL_MS", 10 * 60_000);
}

const FAILURE_RETRY_MS = 60_000;
const RPC_PROBE_ID = "__sq_model_probe";

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** Reject `p` after `ms` — the probe wrapper that guarantees "degrades to default, never hangs". */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/** Iterate LF-delimited JSON frames from a child's stdout, invoking `onFrame` per parsed frame
 *  (non-JSON lines are skipped — omp children interleave log noise). Returns when the callback
 *  answers `true` ("done"), throws if the stream ends first. */
async function eachJsonLine(stdout: ReadableStream<Uint8Array>, onFrame: (frame: Record<string, unknown>) => boolean): Promise<void> {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of stdout) {
		buf += decoder.decode(chunk, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			let frame: unknown;
			try {
				frame = JSON.parse(line);
			} catch {
				continue; // interleaved non-JSON noise — not ours to interpret
			}
			if (isObj(frame) && onFrame(frame)) return;
		}
	}
	throw new Error("child exited before answering the model probe");
}

/**
 * Cold-probe an omp-rpc harness: spawn the CLI in `--mode rpc`, send `get_available_models`, return
 * the raw models array from the correlated response frame. Ephemeral by construction:
 * `--no-session` (nothing persisted), tmpdir cwd (omp refuses to start in ~), child killed in
 * `finally`. The command is written immediately — omp answers before its ready frame is required,
 * and pi never emits one (registry `emitsReadyFrame:false`), both live-verified.
 *
 * @substrate exported for tests only — production reaches it through `discoverHarnessModels`.
 */
export async function probeRpcModels(argv: string[], opts: { timeoutMs: number; env: Record<string, string>; cwd: string }): Promise<unknown[]> {
	const proc = Bun.spawn(argv, { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: opts.env });
	try {
		proc.stdin.write(`${JSON.stringify({ type: "get_available_models", id: RPC_PROBE_ID })}\n`);
		proc.stdin.flush();
		let models: unknown[] = [];
		await withTimeout(
			eachJsonLine(proc.stdout, (frame) => {
				if (frame.type !== "response" || frame.id !== RPC_PROBE_ID) return false;
				if (frame.success === false) throw new Error(typeof frame.error === "string" ? frame.error : "get_available_models failed");
				// The models array rides `data` in the response frame (decodeResponseFrame's shape);
				// tolerate a top-level `models` too rather than knowing one CLI build's framing too well.
				const payload = isObj(frame.data) ? frame.data : frame;
				if (Array.isArray(payload.models)) models = payload.models;
				return true;
			}),
			opts.timeoutMs,
			`${argv[0]} model probe`,
		);
		return models;
	} finally {
		try {
			proc.kill();
		} catch {
			/* already gone */
		}
	}
}

/**
 * Cold-probe an ACP harness: spawn the adapter, run `initialize` → `session/new`, return
 * `models.availableModels` from the session/new result (entries carry `modelId`/`name` —
 * `modelOptionsFromRuntime` maps both that shape and RPC's `id`/`provider`). Incoming
 * agent-to-client requests during the handshake are declined (method-not-found) — a probe has no
 * editor to offer. Child killed in `finally`; a session is created but never prompted.
 *
 * @substrate exported for tests only — production reaches it through `discoverHarnessModels`.
 */
export async function probeAcpModels(argv: string[], opts: { timeoutMs: number; env: Record<string, string>; cwd: string }): Promise<unknown[]> {
	const proc = Bun.spawn(argv, { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: opts.env });
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let streamDown: Error | undefined; // set when the child's stdout ends/errors — later sends fail FAST, not at the timeout
	let nextId = 0;
	const send = (method: string, params: unknown): Promise<unknown> => {
		if (streamDown) return Promise.reject(streamDown);
		const id = ++nextId;
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		proc.stdin.flush();
		return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
	};
	const reader = eachJsonLine(proc.stdout, (frame) => {
		const id = typeof frame.id === "number" ? frame.id : undefined;
		if (id !== undefined && !("method" in frame) && pending.has(id)) {
			const p = pending.get(id)!;
			pending.delete(id);
			if (isObj(frame.error)) p.reject(new Error(typeof frame.error.message === "string" ? frame.error.message : JSON.stringify(frame.error)));
			else p.resolve(frame.result);
		} else if (id !== undefined && typeof frame.method === "string") {
			// Agent-initiated request (fs/*, permission, …) — decline; the probe is not an editor.
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "model probe declines client requests" } })}\n`);
			proc.stdin.flush();
		}
		return false; // the handshake below decides when we're done
	}).catch((err: unknown) => {
		streamDown = new Error(errText(err));
		for (const [, p] of pending) p.reject(streamDown);
		pending.clear();
	});
	try {
		return await withTimeout(
			(async () => {
				await send("initialize", {
					protocolVersion: 1,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: "omp-squad-model-probe", version: "1" },
				});
				const sess = await send("session/new", { cwd: opts.cwd, mcpServers: [] });
				const models = isObj(sess) && isObj(sess.models) ? sess.models.availableModels : undefined;
				return Array.isArray(models) ? models : [];
			})(),
			opts.timeoutMs,
			`${argv[0]} acp model probe`,
		);
	} finally {
		try {
			proc.kill();
		} catch {
			/* already gone */
		}
		void reader; // pump task ends with the killed child's stream
	}
}

/** The argv a cold probe spawns for `d` — the registry's own launch shape, with argv[0] resolved to
 *  an absolute path on the SAME augmented PATH `binDetected` used to admit the harness (a bare
 *  `omp` lives in node_modules/.bin here; the scrubbed child PATH alone may not find it). */
function probeArgv(d: HarnessDescriptor): string[] {
	if (d.protocol === "acp") {
		const cmd = resolveAcpCommand(d) ?? [d.bin];
		const resolved = resolveHarnessBinPath(cmd[0] ?? d.bin);
		return [resolved ?? cmd[0] ?? d.bin, ...cmd.slice(1)];
	}
	const bin = resolveBin(d);
	const resolved = resolveHarnessBinPath(bin);
	return [resolved ?? bin, "--mode", "rpc", "--no-session", "--cwd", os.tmpdir()];
}

function staticCatalog(d: HarnessDescriptor): DiscoveredModelOption[] {
	return (d.staticModels ?? []).map((id) => ({ label: id, value: id, harness: d.name, provenance: "static-catalog" as const }));
}

/**
 * One harness's cold answer, uncached: probe by protocol, map through `modelOptionsFromRuntime`
 * (the same mapper `manager.modelOptions()` uses on live answers, so cold and live options are
 * byte-compatible), tag with harness + provenance. A failed probe returns the descriptor's
 * `staticModels` catalog (provenance `"static-catalog"`) — or an empty list — with `error` set;
 * it never throws and never exceeds `timeoutMs`.
 *
 * @substrate exported for tests only — production reaches it through `ensureHarnessModels`'s cache.
 */
export async function discoverHarnessModels(d: HarnessDescriptor, opts: ProbeOptions = {}): Promise<HarnessModelDiscovery> {
	const timeoutMs = opts.timeoutMs ?? probeTimeoutMs();
	const cwd = opts.cwd ?? os.tmpdir();
	const env = opts.env ?? scrubbedSpawnEnv(process.env, harnessAuthEnv(process.env, d.name));
	const argv = opts.argv ?? probeArgv(d);
	try {
		const raw = d.protocol === "acp" ? await probeAcpModels(argv, { timeoutMs, env, cwd }) : await probeRpcModels(argv, { timeoutMs, env, cwd });
		const models: DiscoveredModelOption[] = modelOptionsFromRuntime(raw).map((o) => ({ ...o, harness: d.name, provenance: "live-probe" as const }));
		return { harness: d.name, provenance: "live-probe", models, at: Date.now() };
	} catch (err) {
		return { harness: d.name, provenance: "static-catalog", models: staticCatalog(d), at: Date.now(), error: errText(err) };
	}
}

// ── Cache + single-flight + enablement ─────────────────────────────────────────────────────────

interface CacheSlot {
	result?: HarnessModelDiscovery;
	inflight?: Promise<HarnessModelDiscovery>;
}

const cache = new Map<string, CacheSlot>();
let enabled = false;

/** Arm discovery for this process. Reached ONLY through `warmModelDiscovery` (cmdUp, real daemon
 *  boot) — never from library construction paths, so no test that builds a SquadServer/SquadManager
 *  ever spawns a real harness CLI. `OMP_SQUAD_MODEL_DISCOVERY=0` is the operator kill switch. */
function enableModelDiscovery(): boolean {
	if (!envBool("OMP_SQUAD_MODEL_DISCOVERY", true)) return false;
	enabled = true;
	return true;
}

/** Boot-time cache warm: arm discovery and kick every detected harness's probe WITHOUT waiting, so
 *  the webapp's mount-time `/api/models` fetch (it fetches exactly once) finds a warm cache instead
 *  of eating the first probe's full latency. Fire-and-forget by design. */
export function warmModelDiscovery(): void {
	if (!enableModelDiscovery()) return;
	void discoveredModelOptions(0);
}

function fresh(slot: CacheSlot | undefined, now: number, opts: ProbeOptions): HarnessModelDiscovery | undefined {
	if (!slot?.result) return undefined;
	const ttl = slot.result.error ? (opts.failureRetryMs ?? FAILURE_RETRY_MS) : (opts.ttlMs ?? successTtlMs());
	return now - slot.result.at < ttl ? slot.result : undefined;
}

/** Cached, single-flight wrapper around `discoverHarnessModels` — the unit `discoveredModelOptions`
 *  fans out over. Concurrent callers share one probe; a fresh success is served for its TTL, a
 *  failure is retried no sooner than `failureRetryMs`.
 *  @substrate exported for tests only — the cache/single-flight/TTL contract is pinned directly. */
export function ensureHarnessModels(d: HarnessDescriptor, opts: ProbeOptions = {}): Promise<HarnessModelDiscovery> {
	const slot = cache.get(d.name) ?? {};
	const hit = fresh(slot, Date.now(), opts);
	if (hit) return Promise.resolve(hit);
	if (slot.inflight) return slot.inflight;
	slot.inflight = discoverHarnessModels(d, opts).then((result) => {
		const s = cache.get(d.name);
		if (s) {
			s.result = result;
			s.inflight = undefined;
		}
		return result;
	});
	cache.set(d.name, slot);
	return slot.inflight;
}

/**
 * Every cold-discovered model option, flattened for `/api/models`.
 *
 * Always answers from the cache; when ARMED (`enableModelDiscovery`), also kicks/refreshes probes
 * for every harness the create surface would offer (listed per `listHarnesses` AND bin-detected —
 * the same honesty filter `harnessDefaultModelOptions` applies) and waits at most `waitMs` for
 * stragglers. Probes that miss the window keep running and land in the cache for the next call.
 * While DISABLED it is a pure cache read — tests seed the cache instead of spawning CLIs.
 */
export async function discoveredModelOptions(waitMs = envInt("OMP_SQUAD_MODEL_DISCOVERY_WAIT_MS", 20_000)): Promise<DiscoveredModelOption[]> {
	const detected = new Set(
		listHarnessTiers()
			.filter((t) => t.binDetected)
			.map((t) => t.name),
	);
	const roster = listHarnesses().filter((d) => detected.has(d.name));
	if (enabled) {
		const pending = roster.map((d) => ensureHarnessModels(d));
		if (waitMs > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, waitMs);
			});
			await Promise.race([Promise.allSettled(pending).then(() => undefined), deadline]);
			clearTimeout(timer);
		}
	}
	const out: DiscoveredModelOption[] = [];
	for (const d of roster) {
		const result = cache.get(d.name)?.result;
		if (result) out.push(...result.models);
	}
	return out;
}

/** Seed one harness's discovery result without any probe — how route tests exercise the
 *  `/api/models` wiring while discovery stays disarmed (no real CLI ever spawns in a test).
 *  @substrate exported for tests only */
export function _seedModelDiscoveryForTests(result: HarnessModelDiscovery): void {
	cache.set(result.harness, { result });
}

/** Drop all discovery state (cache + armed bit) between tests.
 *  @substrate exported for tests only */
export function _resetModelDiscoveryForTests(): void {
	cache.clear();
	enabled = false;
}
