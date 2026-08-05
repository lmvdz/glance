/**
 * Cost-gate ENFORCE wiring at the actual dispatch call site (adw-factory-borrows concern 09) —
 * exercises the REAL `SquadManager.createWithId` seam (via the public `create()`), not just the pure
 * `costGateVerdict`/`shadowCostCheck` functions (see cost-gate.test.ts for those). Review follow-up:
 * "the concern's headline behavior — enforce deny refuses spawn for chore over ceiling — has zero test
 * coverage at the actual createWithId wiring".
 *
 * Follows the FakeDriver + real-temp-git-repo harness pattern from model-route-dispatch.test.ts (itself
 * from execution-role.test.ts) so `create()` runs its real dispatch path without spawning a live omp
 * process.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LANE_POLICY, type WorkLane } from "../src/lane.ts";
import { recordModelOutcome, type ComplexityTier } from "../src/model-outcomes.ts";
import { appendReceipt } from "../src/receipts.ts";
import { recordCostLanded } from "../src/cost-aggregate.ts";
import { recordTaskOutcome } from "../src/task-outcomes.ts";
import { SquadManager, UNATTACHED_ESCALATION_MARKER } from "../src/squad-manager.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

/** Flips `LANE_POLICY[lane].costAction` for the duration of `fn`, restoring it afterward — mirrors
 *  model-route-dispatch.test.ts's `withLaneApplyEnabled`. v1 ships every lane's costAction as either
 *  "shadow" or (chore only) "deny" — no lane is "ask" — so this is the only way to integration-test
 *  the ask→stageCostGateConfirm branch of the create() call site today. */
async function withLaneCostAction<T>(lane: WorkLane, action: "shadow" | "ask" | "deny", fn: () => Promise<T>): Promise<T> {
	const original = LANE_POLICY[lane].costAction;
	LANE_POLICY[lane].costAction = action;
	try {
		return await fn();
	} finally {
		LANE_POLICY[lane].costAction = original;
	}
}

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	delete process.env.OMP_SQUAD_COST_GATE;
	delete process.env.OMP_SQUAD_COST_MAX_PER_CHANGE;
	delete process.env.OMP_SQUAD_COST_MIN_SAMPLE;
});

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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string; stateDir: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo, stateDir };
}

/** Seed `landedCount` landed model-outcome rows AND matching daemon receipts for `(model, tier)` so
 *  `projectCost`'s full-scan fallback (attribution-scoreboard.ts) computes a real, over-ceiling
 *  `costPerLandedChange` — `totalCostUsd / landedCount`. Mirrors model-route-dispatch.test.ts's
 *  `seedOutcomes`, but for the cost axis rather than land-rate. */
async function seedOverCeilingCost(stateDir: string, model: string, tier: ComplexityTier, landedCount: number, totalCostUsd: number): Promise<void> {
	const perRun = totalCostUsd / landedCount;
	for (let i = 0; i < landedCount; i++) {
		recordModelOutcome(stateDir, model, tier, true);
		// Landed counts must reach the lane-keyed aggregate too: enforce-mode "deny" only fires from an
		// AGGREGATE-sourced projection (the lane-blind legacy full-scan downgrades to "ask" — see
		// costGateVerdict), so the seed mirrors production's land() wire (recordCostLanded beside
		// recordModelOutcome) and stamps `tier` on the receipt the way the run seed does.
		recordCostLanded(stateDir, model, tier, undefined);
		await appendReceipt(stateDir, {
			agentId: `cost-seed-${model}-${tier}-${i}`,
			name: `cost-seed-${i}`,
			repo: "/seed-repo",
			runId: `run-${i}`,
			startedAt: Date.now(),
			endedAt: Date.now(),
			status: "idle",
			toolCalls: 1,
			toolTally: {},
			filesTouched: [],
			model,
			tier,
			costUsd: perRun,
		});
	}
}

const MODEL = "claude-sonnet-5"; // modelFamily() -> "sonnet"
const TIER: ComplexityTier = "mid"; // tierOf(undefined) === "mid" (createOpts below sets no `thinking`)

const createOpts = (repo: string, name: string, over: Record<string, unknown> = {}) => ({
	name,
	repo,
	approvalMode: "yolo" as const,
	model: MODEL, // explicit — skips model-route entirely, isolating this to the cost-gate axis
	...over,
});

test("enforce + chore lane over its $2 ceiling: create() THROWS and files the UNATTACHED_ESCALATION_MARKER automation event", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-enforce-deny");
	await seedOverCeilingCost(stateDir, MODEL, TIER, 5, 25); // $5/landed-change, well over chore's $2 ceiling
	process.env.OMP_SQUAD_COST_GATE = "enforce";

	await expect(mgr.create(createOpts(repo, "over-ceiling", { lane: "chore" }))).rejects.toThrow(/cost-gate/i);

	const events = mgr.automationActivity({ loop: "land" }).events;
	expect(events.length).toBeGreaterThanOrEqual(1);
	expect(events[0]?.detail).toContain(UNATTACHED_ESCALATION_MARKER);
	expect(events[0]?.detail).toContain("would DENY");
	// No worktree/record was created for the refused spawn.
	expect(mgr.list().some((a) => a.name === "over-ceiling")).toBe(false);
	await mgr.stop();
});

test("enforce + chore lane UNDER its ceiling: create() succeeds normally", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-enforce-under");
	await seedOverCeilingCost(stateDir, MODEL, TIER, 5, 5); // $1/landed-change — under chore's $2 ceiling
	process.env.OMP_SQUAD_COST_GATE = "enforce";

	const dto = await mgr.create(createOpts(repo, "under-ceiling", { lane: "chore" }));
	expect(dto.id).toBeDefined();
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);
	await mgr.stop();
});

test("enforce + feature/hotfix lane over ceiling: NEVER denies in v1 (costAction stays shadow) — create() succeeds", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-enforce-shadow-lane");
	await seedOverCeilingCost(stateDir, MODEL, TIER, 5, 999); // wildly over any reasonable ceiling
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1"; // a global ceiling exists — only the lane's costAction protects it

	const dto = await mgr.create(createOpts(repo, "hotfix-over", { lane: "hotfix" }));
	expect(dto.id).toBeDefined(); // hotfix's costAction is "shadow" — logs, never blocks
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);
	await mgr.stop();
});

test("SHADOW mode (not enforce): even a chore-lane spawn wildly over ceiling is never refused", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-shadow-mode");
	await seedOverCeilingCost(stateDir, MODEL, TIER, 5, 999);
	process.env.OMP_SQUAD_COST_GATE = "shadow"; // not enforce — the whole gate only ever logs

	const dto = await mgr.create(createOpts(repo, "shadow-mode", { lane: "chore" }));
	expect(dto.id).toBeDefined();
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);
	await mgr.stop();
});

test("enforce + a lane flipped to 'ask': create() succeeds AND stages the SAME 'Needs you' attention-lane confirm a landConfirm-held unit uses", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-enforce-ask");
	await seedOverCeilingCost(stateDir, MODEL, TIER, 5, 25); // over ceiling
	process.env.OMP_SQUAD_COST_GATE = "enforce";

	const dto = await withLaneCostAction("chore", "ask", () => mgr.create(createOpts(repo, "ask-me", { lane: "chore" })));
	expect(dto.id).toBeDefined(); // "ask" never holds the spawn (no pending-create queue, by design)
	const events = dto.attentionEvents ?? [];
	expect(events.length).toBeGreaterThanOrEqual(1);
	expect(events[0]?.summary).toContain("cost-gate(enforce) ASK");
	expect(events[0]?.detail).toContain("would ASK");
	await mgr.stop();
});

test("cost-gate-verdict learning metric is recorded for BOTH enforce (real) and shadow (would-have) verdicts", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-metric-enforce");
	await seedOverCeilingCost(stateDir, MODEL, TIER, 5, 25);
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	await expect(mgr.create(createOpts(repo, "metric-deny", { lane: "chore" }))).rejects.toThrow();
	const rollup = mgr.learningMetricsSnapshot(24 * 3_600_000).rollup;
	const row = rollup.find((r) => r.name === "cost-gate-verdict");
	expect(row).toBeDefined();
	expect(row!.byTag?.action?.deny?.count).toBeGreaterThanOrEqual(1);
	expect(row!.byTag?.mode?.enforce?.count).toBeGreaterThanOrEqual(1);
	await mgr.stop();
});

test("lane-classification learning metric is recorded on every spawn, regardless of the cost gate", async () => {
	const { mgr, repo } = await makeMgr("lane-classification-metric");
	const dto = await mgr.create(createOpts(repo, "lane-metric", { lane: "chore" }));
	expect(dto.id).toBeDefined();
	const rollup = mgr.learningMetricsSnapshot(24 * 3_600_000).rollup;
	const row = rollup.find((r) => r.name === "lane-classification");
	expect(row).toBeDefined();
	expect(row!.byTag?.lane?.chore?.count).toBeGreaterThanOrEqual(1);
	await mgr.stop();
});

// ── ticket #347 / PR #359 blind review (codex, HIGH #2): the cost gate must price the model that
// will ACTUALLY run, not a routed pick the harness-compat guard is about to remap away ────────────
//
// Reproduces the exact bypass codex's review named: routing selects "opus" (cheap, well under the
// chore lane's $2 ceiling); the unit's harness is "grok" (xai-pinned), so ticket #347's compat guard
// remaps the applied model to "grok-4.5" — which is EXPENSIVE, well over the ceiling. Before the
// squad-manager.ts reorder (compat guard now runs BEFORE `shadowCostCheck`, not after), the cost gate
// would have projected against "opus"'s cheap history, returned no verdict, and let the spawn through
// — which would then silently run the over-ceiling "grok-4.5", a complete enforce-mode bypass via
// ordering. With the reorder, the gate prices "grok-4.5" and denies.

/** Seeds the ("none","heavy") task-class cell with strong opus-over-sonnet evidence — same shape as
 *  model-route-dispatch.test.ts's `seedStrongShiftEvidenceNoneHeavy`, duplicated locally so this file
 *  stays self-contained (it already owns its own cost-axis seeding helper, `seedOverCeilingCost`). */
async function seedStrongShiftEvidenceNoneHeavy(stateDir: string): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await recordTaskOutcome(stateDir, { agentId: `sonnet-none-heavy-${i}`, routing: { mode: "none", tier: "heavy" }, model: "claude-sonnet-5", costUsd: 1, outcome: i < 2 ? "landed" : "rejected", source: "land", ts: Date.now() }); // 0.2 land-rate
		await recordTaskOutcome(stateDir, { agentId: `opus-none-heavy-${i}`, routing: { mode: "none", tier: "heavy" }, model: "claude-opus-4-8", costUsd: 1, outcome: i < 9 ? "landed" : "rejected", source: "land", ts: Date.now() }); // 0.9 land-rate
	}
}

test("cost gate prices the REMAPPED model, not the pre-remap route: routed opus (cheap) → grok harness remaps to grok-4.5 (over ceiling) → enforce DENIES on grok-4.5, never silently passes as opus", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-compat-order");
	await seedStrongShiftEvidenceNoneHeavy(stateDir); // routes "opus" for the ("none","heavy") taskClass
	await seedOverCeilingCost(stateDir, "opus", "heavy", 5, 5); // $1/landed — cheap, under chore's $2 ceiling
	await seedOverCeilingCost(stateDir, "grok-4.5", "heavy", 5, 25); // $5/landed — over chore's $2 ceiling
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0"; // apply the route, don't just shadow-log it
	process.env.OMP_SQUAD_COST_GATE = "enforce";

	await expect(
		mgr.create({ name: "route-remap-cost", repo, harness: "grok", approvalMode: "yolo", thinking: "high" as const, autoRoute: false, lane: "chore" as const }),
	).rejects.toThrow(/cost-gate/i);

	const events = mgr.automationActivity({ loop: "land" }).events;
	expect(events.length).toBeGreaterThanOrEqual(1);
	// The denied projection is priced against the model that would ACTUALLY run (grok-4.5) — not the
	// pre-remap routed pick (opus), which never appears in the verdict at all.
	expect(events[0]?.detail).toContain("grok-4.5");
	expect(events[0]?.detail).not.toContain("opus");
	expect(mgr.list().some((a) => a.name === "route-remap-cost")).toBe(false); // never spawned
	await mgr.stop();
});

test("flip side: same setup but claude-code (anthropic-pinned, compatible with routed opus) — opus's OWN cheap history is what the gate sees, and it passes", async () => {
	const { mgr, repo, stateDir } = await makeMgr("cost-compat-order-compatible");
	await seedStrongShiftEvidenceNoneHeavy(stateDir);
	await seedOverCeilingCost(stateDir, "opus", "heavy", 5, 5); // cheap — under ceiling
	await seedOverCeilingCost(stateDir, "grok-4.5", "heavy", 5, 25); // irrelevant to this harness
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
	process.env.OMP_SQUAD_COST_GATE = "enforce";

	const dto = await mgr.create({ name: "route-compatible-cost", repo, harness: "claude-code", approvalMode: "yolo", thinking: "high" as const, autoRoute: false, lane: "chore" as const });
	expect(dto.model).toBe("opus"); // no remap — same-vendor pass-through
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]); // opus's cheap history clears the ceiling
	await mgr.stop();
});
