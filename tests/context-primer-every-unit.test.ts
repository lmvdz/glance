/**
 * The cold-start context primer must reach EVERY unit, not just feature-linked ones.
 *
 * R3, the founding brief's "units are context-poor": a glance unit received task text and (supposedly) a
 * BM25 fabric primer, while an interactive Claude Code session carried CLAUDE.md, memory, skills and MCP.
 *
 * It was worse than that. The primer was gated on `opts.featureId`, and NOTHING that dispatch spawns
 * carries one — `dispatchSpawn` calls `create({repo, name, branch, task, issue})` with no featureId, and
 * neither does `glance add`. Only the feature-linked `POST /api/features/:id/agents` path set it. So the
 * primer never ran for a dispatched or ad-hoc unit.
 *
 * And nothing said so: the `primer-empty` learning metric is recorded INSIDE that same branch, so it has
 * zero records across the operator's entire learning-metrics log (1,000+ entries of other metrics). The
 * instrument was inside the thing it was meant to measure.
 *
 * `primeContext` is driven directly; the real `createWithId` spawns an agent host.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Actor, CreateAgentOptions } from "../src/types.ts";
import type { FabricSnapshot } from "../src/fabric.ts";

const { SquadManager } = await import("../src/squad-manager.ts");

const ENV = ["OMP_SQUAD_CONTEXT_PRIMER", "OMP_SQUAD_PRIMER_TIMEOUT_MS", "OMP_SQUAD_PRIMER_BACKOFF_MS"] as const;
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

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

/** A real `FabricSnapshot` (src/fabric.ts) carrying one decision fact that matches the query. */
function snapshotWith(featureTitle: string, text: string): FabricSnapshot {
	return {
		actor: "local",
		generatedAt: Date.now(),
		scope: ["/srv/app"],
		agents: [],
		digests: [],
		hotAreas: [],
		scout: [],
		leases: [],
		decisions: [{ type: "decision", source: { repo: "/srv/app", featureId: "f0" }, featureTitle, text, createdAt: Date.now() }],
		failures: [],
		symptoms: [],
	} as unknown as FabricSnapshot;
}

/** Exposes the protected seam and stubs the fabric read. */
class PrimerManager extends SquadManager {
	fabricCalls = 0;
	snapshot: FabricSnapshot = snapshotWith("retry budget", "we capped retries at 3 after the thrash incident");
	fabricThrows = false;

	override async fabric(): Promise<FabricSnapshot> {
		this.fabricCalls++;
		if (this.fabricThrows) throw new Error("fabric unavailable");
		return this.snapshot;
	}
	clock?: () => number;
	setClock(fn: () => number): void {
		this.clock = fn;
	}
	protected override now(): number {
		return this.clock ? this.clock() : super.now();
	}
	prime(opts: CreateAgentOptions): Promise<{ opts: CreateAgentOptions; hasPrimer: boolean }> {
		return this.primeContext(opts, { id: "local", origin: "local" } as Actor);
	}
}

async function manager(): Promise<PrimerManager> {
	return new PrimerManager({ stateDir: await tmpDir("primer-") } as never);
}

const DISPATCHED: CreateAgentOptions = { repo: "/srv/app", name: "ompsq-445", task: "OMPSQ-445: wire the retry budget" } as CreateAgentOptions;

// ── the defect ──────────────────────────────────────────────────────────────────────────────────

test("a DISPATCHED unit (no featureId) gets the primer — it never did before", async () => {
	const mgr = await manager();
	const { opts, hasPrimer } = await mgr.prime(DISPATCHED);

	expect(hasPrimer).toBe(true);
	expect(mgr.fabricCalls).toBe(1);
	expect(opts.appendSystemPrompt).toContain("retry budget");
	expect(opts.appendSystemPrompt).toContain("capped retries at 3");
});

test("an ad-hoc `glance add` unit (name only, no task, no featureId) gets it too", async () => {
	const mgr = await manager();
	const { hasPrimer, opts } = await mgr.prime({ repo: "/srv/app", name: "retry budget" } as CreateAgentOptions);
	expect(hasPrimer).toBe(true);
	expect(opts.appendSystemPrompt).toContain("retry budget");
});

test("a feature-linked unit still gets it — no regression on the one path that worked", async () => {
	const mgr = await manager();
	const { hasPrimer } = await mgr.prime({ ...DISPATCHED, featureId: "f1" } as CreateAgentOptions);
	expect(hasPrimer).toBe(true);
});

/** The primer is untrusted third-party text (prior units wrote it). `buildContextPrimer` fences it; this
 *  must not be re-fenced, and it must never masquerade as instructions. */
test("the primer arrives fenced as untrusted data, exactly once", async () => {
	const mgr = await manager();
	const { opts } = await mgr.prime(DISPATCHED);
	const fences = (opts.appendSystemPrompt ?? "").match(/BEGIN UNTRUSTED|untrusted/gi) ?? [];
	expect(fences.length).toBeGreaterThan(0);
	expect(opts.appendSystemPrompt).toContain("read-only, may be stale");
});

test("an existing appendSystemPrompt (profile memory, tool grants) is preserved, primer appended", async () => {
	const mgr = await manager();
	const { opts } = await mgr.prime({ ...DISPATCHED, appendSystemPrompt: "PROFILE MEMORY" } as CreateAgentOptions);
	expect(opts.appendSystemPrompt?.startsWith("PROFILE MEMORY")).toBe(true);
	expect(opts.appendSystemPrompt).toContain("retry budget");
});

// ── never block a spawn ─────────────────────────────────────────────────────────────────────────

test("a fabric failure logs and the spawn proceeds unprimed — never blocked", async () => {
	const mgr = await manager();
	mgr.fabricThrows = true;
	const { opts, hasPrimer } = await mgr.prime(DISPATCHED);
	expect(hasPrimer).toBe(false);
	expect(opts).toEqual(DISPATCHED); // untouched
});

test("an empty fabric ⇒ no primer, and the spawn is untouched", async () => {
	const mgr = await manager();
	mgr.snapshot = snapshotWith("something wholly unrelated", "nothing matches the query at all");
	const { hasPrimer } = await mgr.prime({ repo: "/srv/app", task: "zzzzqqqq nonmatching" } as CreateAgentOptions);
	expect(hasPrimer).toBe(false);
});

test("nothing to search on ⇒ the fabric is never even read", async () => {
	const mgr = await manager();
	const { hasPrimer } = await mgr.prime({ repo: "/srv/app" } as CreateAgentOptions);
	expect(hasPrimer).toBe(false);
	expect(mgr.fabricCalls).toBe(0);
});

test("OMP_SQUAD_CONTEXT_PRIMER=0 disables it entirely", async () => {
	process.env.OMP_SQUAD_CONTEXT_PRIMER = "0";
	const mgr = await manager();
	const { hasPrimer } = await mgr.prime(DISPATCHED);
	expect(hasPrimer).toBe(false);
	expect(mgr.fabricCalls).toBe(0);
});

// ── delivery: the primer must actually REACH the agent ──────────────────────────────────────────

/**
 * `WorkflowDriverOptions` had no `appendSystemPrompt` field at all, so a workflow unit — which is what
 * `--verify` and every routed dispatch produce — ran with NO system-prompt context: no profile memory,
 * no tool grants, no fabric primer, and no authored Tier-2 spec. `RpcAgent` has supported
 * `--append-system-prompt` the whole time. The unit that most needed its spec was the one guaranteed not
 * to get it. Found by cross-lineage review (gpt-5.6-sol): `hasPrimer` was reporting delivery that never
 * happened.
 */
test("a workflow's inner coder inherits the unit's system-prompt context", async () => {
	const { innerAgentOptions } = await import("../src/workflow-driver.ts");
	const inner = innerAgentOptions({ id: "u1", cwd: "/wt", model: "sonnet", bin: "omp", appendSystemPrompt: "PRIMER + SPEC" }, "coder");
	expect(inner.appendSystemPrompt).toBe("PRIMER + SPEC");
	expect(inner.id).toBe("u1-wf");
	expect(inner.model).toBe("sonnet");
});

/** The isolated test-author takes its own MODEL but the same CONTEXT — it must know the spec it is
 *  writing a test for. */
test("the isolated tester lineage gets the same context, its own model", async () => {
	const { innerAgentOptions } = await import("../src/workflow-driver.ts");
	const tester = innerAgentOptions({ id: "u1", cwd: "/wt", model: "sonnet", appendSystemPrompt: "PRIMER + SPEC" }, "tester", "opus");
	expect(tester.appendSystemPrompt).toBe("PRIMER + SPEC");
	expect(tester.id).toBe("u1-tester");
	expect(tester.model).toBe("opus"); // override wins for the tester
});

/**
 * Round-3 review minor: `innerAgentOptions` built its RpcAgentOptions with no `harness`, so
 * `harnessAuthEnv`'s no-model fallback couldn't narrow to Anthropic and admitted every configured
 * provider credential instead — `actualUnitHarness` (squad-manager.ts) already documents "a
 * workflow-kind unit's inner coder/tester is ALWAYS an omp-dialect RpcAgent" as an architectural fact,
 * so this call site can name the harness precisely instead of leaving RpcAgent to guess.
 */
test("both workflow inner lineages (coder and tester) name harness 'omp' — narrows the auth-key fallback instead of admitting every provider credential", async () => {
	const { innerAgentOptions } = await import("../src/workflow-driver.ts");
	expect(innerAgentOptions({ id: "u1", cwd: "/wt" }, "coder").harness).toBe("omp");
	expect(innerAgentOptions({ id: "u1", cwd: "/wt" }, "tester", "opus").harness).toBe("omp");
});

test("no context ⇒ nothing is fabricated onto the inner agent", async () => {
	const { innerAgentOptions } = await import("../src/workflow-driver.ts");
	expect(innerAgentOptions({ id: "u1", cwd: "/wt" }, "coder").appendSystemPrompt).toBeUndefined();
});

// ── bounded: never hang a spawn ─────────────────────────────────────────────────────────────────

/** `fabric()` scans every receipt and digest and calls Plane's untimed issue fetch, and the dispatcher
 *  awaits each spawn serially. "Never blocks a spawn" meant "never fails one" — it could still hang it. */
test("a hanging fabric read times out and the unit spawns unprimed", async () => {
	process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS = "40";
	const mgr = await manager();
	(mgr as unknown as { fabric: () => Promise<never> }).fabric = () => new Promise<never>(() => {}); // never settles

	const t0 = Date.now();
	const { opts, hasPrimer } = await mgr.prime(DISPATCHED);
	expect(hasPrimer).toBe(false);
	expect(opts).toEqual(DISPATCHED);
	expect(Date.now() - t0).toBeLessThan(2000); // bounded, not hung
	delete process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS;
});

/**
 * Timing out the RACE does not cancel the READ. `fabric()` keeps enumerating receipts and waiting on
 * Plane's untimed fetch, while the dispatcher — which spawns serially — moves to the next unit and starts
 * another one. Ten queued issues against a slow fabric meant ten concurrent full scans: the daemon
 * amplifies itself into the stall the timeout was meant to bound. After a timeout, stop asking. (grok-4.5)
 */
test("after a timeout the primer trips a breaker instead of re-scanning on every spawn", async () => {
	process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS = "30";
	const mgr = await manager();
	let reads = 0;
	(mgr as unknown as { fabric: () => Promise<never> }).fabric = () => {
		reads++;
		return new Promise<never>(() => {}); // still running, exactly as in production
	};

	await mgr.prime(DISPATCHED); // trips
	await mgr.prime(DISPATCHED); // skipped
	await mgr.prime(DISPATCHED); // skipped
	expect(reads).toBe(1);

	delete process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS;
});

test("the breaker reopens once the backoff elapses", async () => {
	process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS = "30";
	process.env.OMP_SQUAD_PRIMER_BACKOFF_MS = "1000";
	const mgr = await manager();
	let reads = 0;
	let clock = 10_000;
	mgr.setClock(() => clock);
	let hang = true;
	(mgr as unknown as { fabric: () => Promise<unknown> }).fabric = () => {
		reads++;
		return hang ? new Promise<never>(() => {}) : Promise.resolve(mgr.snapshot);
	};

	await mgr.prime(DISPATCHED);
	expect(reads).toBe(1);

	clock += 999;
	await mgr.prime(DISPATCHED);
	expect(reads).toBe(1); // still open

	clock += 2;
	hang = false;
	expect((await mgr.prime(DISPATCHED)).hasPrimer).toBe(true);
	expect(reads).toBe(2); // reopened, and the primer works again

	delete process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS;
	delete process.env.OMP_SQUAD_PRIMER_BACKOFF_MS;
});

/** A read that FAILS fast (fabric threw) is not a read that's still burning IO. Don't punish it. */
test("a fast failure does not trip the breaker", async () => {
	const mgr = await manager();
	mgr.fabricThrows = true;
	await mgr.prime(DISPATCHED);
	mgr.fabricThrows = false;
	expect((await mgr.prime(DISPATCHED)).hasPrimer).toBe(true);
});

/** Global backoff would let one repo with a stalled Plane fetch silently mute priming for every other
 *  repo the daemon serves — a fleet-wide regression triggered by one slow project. (gpt-5.6-sol) */
test("the breaker is per-repo: a slow repo does not mute a healthy one", async () => {
	process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS = "30";
	const mgr = await manager();
	(mgr as unknown as { fabric: (a: unknown, o: { repos: string[] }) => Promise<unknown> }).fabric = (_a, o) =>
		o.repos[0] === "/srv/slow" ? new Promise<never>(() => {}) : Promise.resolve(mgr.snapshot);

	expect((await mgr.prime({ repo: "/srv/slow", task: "retry budget" } as CreateAgentOptions)).hasPrimer).toBe(false); // trips /srv/slow
	expect((await mgr.prime({ repo: "/srv/app", task: "retry budget" } as CreateAgentOptions)).hasPrimer).toBe(true); // unaffected
	expect((await mgr.prime({ repo: "/srv/slow", task: "retry budget" } as CreateAgentOptions)).hasPrimer).toBe(false); // still open

	delete process.env.OMP_SQUAD_PRIMER_TIMEOUT_MS;
});
