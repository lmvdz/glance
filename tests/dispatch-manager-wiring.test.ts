/**
 * Degradation ladder (concern 06, plans/research-sirvir/06-degradation-ladder.md) — PR #105 built and
 * unit-tested the full per-provider partitioning capability by DIRECT `Dispatcher` construction
 * (tests/rate-limit.test.ts), but deliberately left `squad-manager.ts` unwired: `providerFor` and
 * `secondLaneAvailable` were never supplied to the real `Dispatcher`, so the live daemon still ran the
 * legacy global-freeze path. This file extends that same Dispatcher-construction test pattern one level
 * up — through the REAL `SquadManager`'s own wiring (its actual `this.dispatcher`, its actual
 * `this.rateLimit`, and the actual `dispatchProviderFor`/`hasSecondVerifiedProviderLane` closures it
 * supplies) — against a stub Plane server (root-factory.test.ts's hermetic pattern), proving:
 *
 *   (a) TODAY (no verified second provider lane): the manager's real Dispatcher still runs the
 *       byte-for-byte legacy global freeze — a cap noted for ANY provider string, matching or not,
 *       freezes the whole tick (no regression from the pre-ladder behavior).
 *   (b) Once a second harness is actually verified (a live smoke, simulated via registry override): a
 *       cap for a provider OTHER than the one a real spawn would resolve to no longer blocks dispatch.
 *   (c) ...while a cap for the ACTUAL resolved provider still pauses dispatch — the differentiation is
 *       real, not a fail-open no-op.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { getHarness, registerHarness } from "../src/harness-registry.ts";
import { readReceipts } from "../src/receipts.ts";
import { actualUnitHarness, declaredModelOf, SquadManager, unitProviderKey } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

const ENV = ["OMP_SQUAD_AUTODISPATCH", "OMP_SQUAD_OBSERVE", "OMP_SQUAD_SCOUT", "OMP_SQUAD_OPPORTUNITY", "OMP_SQUAD_PLANSYNC", "OMP_SQUAD_AUTODRIVE", "OMP_SQUAD_PLANE_CACHE_MS", "PLANE_API_KEY", "PLANE_WORKSPACE", "PLANE_BASE_URL", "PLANE_PROJECT_MAP", "GLANCE_HARNESS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV) saved[k] = process.env[k];

const tmps: string[] = [];
afterEach(async () => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Temporarily override one registry entry and ALWAYS restore the original (module-global registry —
 *  mirrors harness-registry.test.ts's own `withHarnessOverride`, async-aware for this file's setup). */
async function withHarnessOverride<T>(name: string, over: Partial<Parameters<typeof registerHarness>[0]>, fn: () => Promise<T>): Promise<T> {
	const original = getHarness(name);
	if (!original) throw new Error(`no registered harness "${name}" to override`);
	registerHarness({ ...original, ...over, name });
	try {
		return await fn();
	} finally {
		registerHarness(original);
	}
}

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}
interface RateLimitLike {
	note: (msg: unknown, delayMs: unknown, provider?: string) => boolean;
}
interface ManagerInternals {
	dispatcher?: { tick: () => Promise<number>; running: boolean };
	rateLimit: RateLimitLike;
}

/** The dispatcher's boot tick (fired fire-and-forget by `Dispatcher.start()` inside `mgr.start()`) races
 *  a test's own controlled `tick()` call — wait for it to fully settle (its `listIssues` round-trip
 *  included) before driving anything deterministic, bounded so a real hang still fails loudly. */
async function waitForIdle(dispatcher: { running: boolean }, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (dispatcher.running) {
		if (Date.now() - start > timeoutMs) throw new Error("dispatcher never went idle");
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

/** A minimal Plane stub whose `/issues/` list is driven by a mutable ref, so the boot tick (fired
 *  synchronously inside `mgr.start()`, before the test can install `makeDriver`) sees an EMPTY backlog
 *  and spawns nothing, while a later, explicitly-awaited `dispatcher.tick()` sees the real issues. */
function planeStub(issuesRef: { current: unknown[] }) {
	return Bun.serve({
		port: 0,
		fetch: (req) => {
			const p = new URL(req.url).pathname;
			if (p.endsWith("/relations/")) return Response.json({ blocked_by: [], blocking: [], relates_to: [] });
			if (p.endsWith("/states/")) return Response.json({ results: [] });
			if (/\/projects\/[^/]+\/$/.test(p)) return Response.json({ identifier: "TST" });
			if (p.endsWith("/issues/")) return Response.json({ results: issuesRef.current });
			return new Response("no", { status: 404 });
		},
	});
}

async function makeWiredManager(): Promise<{ mgr: SquadManager; issuesRef: { current: unknown[] }; stop: () => Promise<void> }> {
	const repo = await makeRepo("dispatch-wiring-repo-");
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-wiring-state-"));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-wiring-wt-"));
	tmps.push(stateDir, worktreeBase);
	const issuesRef = { current: [] as unknown[] };
	const plane = planeStub(issuesRef);
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${plane.port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ [repo]: "proj-1" });
	process.env.OMP_SQUAD_OBSERVE = "0";
	process.env.OMP_SQUAD_SCOUT = "0";
	process.env.OMP_SQUAD_OPPORTUNITY = "0";
	process.env.OMP_SQUAD_PLANSYNC = "0";
	process.env.OMP_SQUAD_AUTODRIVE = "0";
	// listPlaneIssues caches successful reads for OMP_SQUAD_PLANE_CACHE_MS (default 15s) — the boot tick's
	// fetch, which sees an EMPTY backlog, would otherwise poison that cache and starve the test's own
	// controlled tick() of the issues populated below.
	process.env.OMP_SQUAD_PLANE_CACHE_MS = "0";
	delete process.env.OMP_SQUAD_AUTODISPATCH; // default ON — arms the real Dispatcher

	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start(); // boot tick sees issuesRef.current === [] — nothing spawns
	await waitForIdle((mgr as unknown as ManagerInternals).dispatcher!); // let the boot tick fully settle before driving our own
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();

	issuesRef.current = [
		{ id: "iss-a", sequence_id: 1, name: "issue a", state_detail: { group: "unstarted" }, description_stripped: "spec a" },
		{ id: "iss-b", sequence_id: 2, name: "issue b", state_detail: { group: "unstarted" }, description_stripped: "spec b" },
	];
	return {
		mgr,
		issuesRef,
		stop: async () => {
			await mgr.stop();
			plane.stop(true);
		},
	};
}

test("today (no verified second provider lane): a cap on ANY provider still freezes the whole real-manager tick", async () => {
	const { mgr, stop } = await makeWiredManager();
	const internals = mgr as unknown as ManagerInternals;
	expect(internals.dispatcher).toBeDefined(); // the ladder deps are wired, but inert without a second lane

	// A provider that would NEVER match this fleet's resolved (default-harness, no-model) provider —
	// under the legacy no-arg top-of-tick check this still freezes everything, exactly as before the ladder.
	internals.rateLimit.note("429 usage limit", 10 * 60_000, "openai");
	const spawned = await internals.dispatcher!.tick();
	expect(spawned).toBe(0);
	await stop();
}, 20_000);

test("a real second verified provider lane: a MISMATCHED cap no longer blocks the real-manager tick", async () => {
	await withHarnessOverride("codex", { verified: true }, async () => {
		const { mgr, stop } = await makeWiredManager();
		const internals = mgr as unknown as ManagerInternals;

		// codex (openai) is now a genuinely verified, differently-provider'd lane vs the default "omp"
		// harness (unknown lineage) — hasSecondVerifiedProviderLane() flips true through the REAL wired
		// closure. Capping "openai" must NOT touch the default-harness units' bucket.
		internals.rateLimit.note("429 usage limit", 10 * 60_000, "openai");
		const spawned = await internals.dispatcher!.tick();
		expect(spawned).toBe(2); // both units dispatch — the cap landed on a bucket neither of them resolves to
		await stop();
	});
}, 20_000);

test("a real second verified provider lane: a cap on the ACTUAL resolved provider still pauses the real-manager tick", async () => {
	await withHarnessOverride("codex", { verified: true }, async () => {
		const { mgr, stop } = await makeWiredManager();
		const internals = mgr as unknown as ManagerInternals;

		// The default "omp" harness with no explicit model resolves to "unknown", which RateLimitGate
		// folds into DEFAULT_PROVIDER ("anthropic") — noting a cap with no provider (or "unknown") lands
		// in exactly that bucket, so it MUST still pause every default-harness unit.
		internals.rateLimit.note("429 usage limit", 10 * 60_000, "unknown");
		const spawned = await internals.dispatcher!.tick();
		expect(spawned).toBe(0);
		await stop();
	});
}, 20_000);

// ── cross-lineage review findings (PR #112): gate-key/record-key symmetry + actual-runtime keys ──

test("unitProviderKey: gate key ≡ record key across the (harness, declaredModel) matrix — one shared helper", () => {
	// The gate (dispatchProviderFor) and the record site (auto_retry_start) both evaluate
	// unitProviderKey; symmetry means: for any declared configuration, the key the gate would compute
	// for a prospective unit equals the key the record site computes for the unit actually spawned
	// from that configuration (whose only extra input is declaredModelOf — the identity function for
	// any operator/profile-declared model).
	const combos: Array<{ harness?: string; model?: string; want: string }> = [
		{ harness: undefined, model: undefined, want: "unknown" }, // default omp — multi-model, no vendor pin
		{ harness: "omp", model: undefined, want: "unknown" },
		{ harness: "pi", model: undefined, want: "unknown" },
		{ harness: "codex", model: undefined, want: "openai" }, // vendor-pinned harness
		{ harness: "claude-code", model: undefined, want: "anthropic" },
		{ harness: "gemini", model: undefined, want: "google" },
		{ harness: undefined, model: "gpt-5.5", want: "openai" }, // declared model wins
		{ harness: undefined, model: "opus", want: "anthropic" },
		{ harness: "codex", model: "claude-opus-4-8", want: "anthropic" }, // model beats the harness pin
		{ harness: "claude-code", model: "openai/gpt-5.5", want: "openai" },
	];
	for (const c of combos) {
		const gateKey = unitProviderKey({ kind: "omp-operator", harness: c.harness, declaredModel: c.model });
		const recordKey = unitProviderKey({ kind: "omp-operator", harness: c.harness, declaredModel: declaredModelOf({ model: c.model }) });
		expect(recordKey).toBe(gateKey);
		expect(gateKey).toBe(c.want);
	}
});

test("declaredModelOf: excludes exactly the router-applied model, keeps operator/profile-declared ones", () => {
	// Router applied THIS model (routedModel === model) ⇒ excluded from the provider key.
	expect(declaredModelOf({ model: "gpt-5.5", routing: { routedModel: "gpt-5.5" } })).toBeUndefined();
	// Operator-declared (no routing mark, or a mark for a DIFFERENT model — the operator overrode it).
	expect(declaredModelOf({ model: "gpt-5.5" })).toBe("gpt-5.5");
	expect(declaredModelOf({ model: "gpt-5.5", routing: { routedModel: "opus" } })).toBe("gpt-5.5");
	expect(declaredModelOf({})).toBeUndefined();
});

test("actualUnitHarness: workflow/flue kinds pin their real inner runtime, never the GLANCE_HARNESS env default", () => {
	process.env.GLANCE_HARNESS = "codex";
	expect(actualUnitHarness({ kind: "workflow" })).toBe("omp"); // acquireInner is always an omp-dialect RpcAgent
	expect(actualUnitHarness({ kind: "flue-service" })).toBe("flue"); // FlueServiceDriver runs `flue run`
	expect(actualUnitHarness({})).toBe("codex"); // plain operator unit genuinely resolves the env default
	expect(actualUnitHarness({ kind: "omp-operator", harness: "pi" })).toBe("pi"); // explicit harness wins
});

/** Light manager (no Plane stub) for the record-site tests — the dispatcher isn't under test here. */
async function makePlainMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string; stateDir: string }> {
	process.env.OMP_SQUAD_AUTODISPATCH = "0";
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
	tmps.push(stateDir, repo);
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	await mgr.start();
	(mgr as unknown as { makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver }).makeDriver = () => new FakeDriver();
	return { mgr, repo, stateDir };
}

interface RecordInternals {
	agents: Map<string, { dto: { id: string; model?: string }; options: PersistedAgent; run?: unknown }>;
	onAgentEvent: (rec: unknown, frame: { type?: string; [k: string]: unknown }) => void;
	finalizeRun: (rec: unknown) => Promise<void>;
	rateLimit: { paused: (provider?: string) => boolean };
}

test("a ROUTER-applied model's cap records under the gate's bucket, not the routed provider's (no gate/record drift)", async () => {
	const { mgr, repo } = await makePlainMgr("routed-cap");
	const internals = mgr as unknown as RecordInternals;
	const dto = await mgr.create({ name: "routed", repo, approvalMode: "yolo", autoRoute: false });
	const rec = internals.agents.get(dto.id)!;
	// Simulate the model-route apply path having chosen an OpenAI model (the real router only picks the
	// Anthropic frontier today — this is the forward-looking drift the review flagged): opts.model was
	// set by the router AND marked in routing.routedModel, exactly as createWithId's apply branch stamps it.
	rec.options.model = "gpt-5.5";
	rec.options.routing = { ...(rec.options.routing ?? { mode: "none", tier: "light", routedAt: Date.now() }), routedModel: "gpt-5.5" };

	internals.onAgentEvent(rec, { type: "auto_retry_start", errorMessage: "429 usage limit reached", delayMs: 5 * 60_000 });

	// The cap must land in the bucket the dispatcher's pre-routing gate checks (default lane →
	// "unknown" → folded to anthropic), NOT the routed model's openai bucket — otherwise per-unit
	// gating would keep dispatching new units straight into the capped routed lane.
	expect(internals.rateLimit.paused("openai")).toBe(false);
	expect(internals.rateLimit.paused("anthropic")).toBe(true);
	await mgr.stop();
});

test("an OPERATOR-declared model's cap records under its own provider (declared config stays in the key)", async () => {
	const { mgr, repo } = await makePlainMgr("declared-cap");
	const internals = mgr as unknown as RecordInternals;
	const dto = await mgr.create({ name: "declared", repo, approvalMode: "yolo", autoRoute: false, model: "gpt-5.5" });
	const rec = internals.agents.get(dto.id)!;

	internals.onAgentEvent(rec, { type: "auto_retry_start", errorMessage: "429 usage limit reached", delayMs: 5 * 60_000 });

	expect(internals.rateLimit.paused("openai")).toBe(true);
	expect(internals.rateLimit.paused("anthropic")).toBe(false);
	await mgr.stop();
});

test("workflow-kind under GLANCE_HARNESS=codex: receipt harness 'omp', cap bucket anthropic (actual inner runtime, both axes)", async () => {
	process.env.GLANCE_HARNESS = "codex";
	const { mgr, repo, stateDir } = await makePlainMgr("wf-actual-runtime");
	const internals = mgr as unknown as RecordInternals;
	// `verify` ⇒ kind "workflow" — its inner coder is ALWAYS an omp-dialect RpcAgent, whatever the env default.
	const dto = await mgr.create({ name: "wf", repo, approvalMode: "yolo", autoRoute: false, verify: "true" });
	const rec = internals.agents.get(dto.id)!;
	expect(rec.options.kind).toBe("workflow");

	internals.onAgentEvent(rec, { type: "agent_start" });
	internals.onAgentEvent(rec, { type: "auto_retry_start", errorMessage: "429 usage limit reached", delayMs: 5 * 60_000 });
	await internals.finalizeRun(rec);

	// Receipt axis: the actual inner runtime, not the env default.
	const [receipt] = await readReceipts(stateDir, dto.id);
	expect(receipt.harness).toBe("omp");
	// Rate-limit axis: the cap folds into the dominant (anthropic) bucket, never openai-via-env-default.
	expect(internals.rateLimit.paused("anthropic")).toBe(true);
	expect(internals.rateLimit.paused("openai")).toBe(false);
	await mgr.stop();
});
