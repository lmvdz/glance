/**
 * Route-at-dispatch wiring (model-routing-control-loop concern 06; per-lane apply widening,
 * adw-factory-borrows concern 09) — exercises the ACTUAL `SquadManager.createWithId` call site, not
 * just the pure `routeModelForTaskClass`/`modelRouteShouldApply` functions (see model-route.test.ts
 * for those). Verifies:
 *   - gate OFF (`OMP_SQUAD_MODEL_OUTCOMES` unset) ⇒ zero behavior change, even with strong seeded
 *     evidence that WOULD shift if the gate were on.
 *   - gate ON, shadow default ⇒ decision logged/recorded but NOT applied (`opts.model` untouched).
 *   - gate ON, `OMP_SQUAD_MODEL_ROUTE_SHADOW=0` (the FLEET-WIDE apply flag) ⇒ the chosen model lands
 *     on the DTO, REGARDLESS of lane or lane source (concern 09 does not narrow this baseline — see
 *     `lane-threading.test.ts`'s clamp tests, which lock exactly this down for a label-sourced lane).
 *   - an operator-sourced lane's OWN `LANE_POLICY[lane].modelRouteApply` flag WIDENS past a global
 *     shadow DEFAULT (simulated by temporarily flipping `LANE_POLICY`, since no real lane defaults to
 *     true yet) — a genuinely per-lane flip independent of the fleet-wide flag; a label/classifier
 *     lane can never do this.
 *   - thin/no-data taskClass ⇒ no shift even with apply otherwise satisfied.
 *   - an explicit `opts.model` is never overridden, gate on or off, apply satisfied or not.
 *
 * Follows the FakeDriver + real-temp-git-repo harness pattern from execution-role.test.ts so
 * `create()` runs its real dispatch path (routeIntake skipped via explicit `verify`, worktree cut for
 * real) without spawning a live omp process.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { LANE_POLICY } from "../src/lane.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { recordTaskOutcome } from "../src/task-outcomes.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

/** Flips a `LANE_POLICY[lane].modelRouteApply` flag to `true` for the duration of `fn`, restoring it
 *  afterward — v1's real constants ship every lane `false` (the flip is a later operator action), so
 *  this is the only way to integration-test the "an operator-sourced lane widens past a global shadow
 *  default" branch of the create() call site today. `LANE_POLICY` is a plain exported const (not
 *  frozen), same convention `lane.test.ts`/`model-route.test.ts` rely on for their own "what if this
 *  were flipped" cases. */
async function withLaneApplyEnabled<T>(lane: keyof typeof LANE_POLICY, fn: () => Promise<T>): Promise<T> {
	const original = LANE_POLICY[lane].modelRouteApply;
	LANE_POLICY[lane].modelRouteApply = true;
	try {
		return await fn();
	} finally {
		LANE_POLICY[lane].modelRouteApply = original;
	}
}

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	delete process.env.OMP_SQUAD_MODEL_OUTCOMES;
	delete process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW;
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

/** Seed `n` outcome rows for `(mode, tier, model)`, `landedCount` of which land — enough real rows
 *  populate a task-class-matrix cell without needing a live roster (row-only membership, same as the
 *  reconciler path / task-class-matrix.test.ts's "reconciled row" case). Every row carries a `costUsd`
 *  so `costCoveragePct` clears `MIN_COVERAGE_PCT` — the `reproducible` gate (eap-borrows concern 01)
 *  `routeModelForTaskClass` now honors alongside `insufficientData`. */
async function seedOutcomes(stateDir: string, mode: string, tier: string, model: string, n: number, landedCount: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		await recordTaskOutcome(stateDir, {
			agentId: `${model}-${mode}-${tier}-${i}`,
			routing: { mode, tier },
			model,
			costUsd: 1,
			outcome: i < landedCount ? "landed" : "rejected",
			source: "land",
			ts: Date.now(),
		});
	}
}

/** Seed strong (well past MIN_SAMPLES + MIN_EDGE) evidence that opus clearly beats sonnet for
 *  ("tdd","heavy") — the taskClass a `verify:"true", verifyMode:"tdd", thinking:"high"` create()
 *  resolves to (`opts.verifyMode ?? "none"` × `tierOf("high") === "heavy"`). */
async function seedStrongShiftEvidence(stateDir: string): Promise<void> {
	await seedOutcomes(stateDir, "tdd", "heavy", "claude-sonnet-5", 10, 2); // 0.2 land-rate
	await seedOutcomes(stateDir, "tdd", "heavy", "claude-opus-4-8", 10, 9); // 0.9 land-rate
}

const createOpts = (repo: string, name: string, over: Record<string, unknown> = {}) => ({
	name,
	repo,
	approvalMode: "yolo" as const,
	verify: "true",
	verifyMode: "tdd" as const,
	thinking: "high" as const,
	...over,
});

test("gate OFF: strong seeded shift evidence does not change dispatch model at all", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-gate-off");
	await seedStrongShiftEvidence(stateDir);
	// OMP_SQUAD_MODEL_OUTCOMES intentionally left unset.
	const dto = await mgr.create(createOpts(repo, "gate-off"));
	expect(dto.model).toBeUndefined();
	const after = mgr.learningMetricsSnapshot(24 * 3_600_000).rollup;
	expect(after.find((r) => r.name === "model-route-decision")).toBeUndefined();
	await mgr.stop();
});

test("gate ON, shadow default: decision is recorded but NOT applied to opts.model", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-shadow");
	await seedStrongShiftEvidence(stateDir);
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	// OMP_SQUAD_MODEL_ROUTE_SHADOW intentionally left unset ⇒ shadow stays ON by default.
	const dto = await mgr.create(createOpts(repo, "shadow"));
	expect(dto.model).toBeUndefined(); // shadow never applies
	const rollup = mgr.learningMetricsSnapshot(24 * 3_600_000).rollup;
	const row = rollup.find((r) => r.name === "model-route-decision");
	expect(row).toBeDefined();
	expect(row!.byTag?.mode?.shadow?.count).toBeGreaterThanOrEqual(1);
	await mgr.stop();
});

test("gate ON, apply mode (SHADOW=0): the chosen frontier model lands on the DTO — unaffected by lane", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-apply");
	await seedStrongShiftEvidence(stateDir);
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
	// No opts.lane — the default (non-operator) lane. The fleet-wide apply flag alone is sufficient
	// (adw-factory-borrows concern 09 does not narrow this baseline; see the module doc).
	const dto = await mgr.create(createOpts(repo, "apply"));
	expect(dto.model).toBe("opus");
	const rollup = mgr.learningMetricsSnapshot(24 * 3_600_000).rollup;
	const row = rollup.find((r) => r.name === "model-route-decision");
	expect(row?.byTag?.mode?.apply?.count).toBeGreaterThanOrEqual(1);
	// The applied model is marked ROUTER-chosen on the durable routing record (PR #112 review finding 1):
	// `unitProviderKey`/`declaredModelOf` exclude it from the rate-limit provider key, so a routed unit's
	// cap can never land in a bucket the dispatcher's pre-routing gate doesn't check.
	const rec = (mgr as unknown as { agents: Map<string, { options: PersistedAgent }> }).agents.get(dto.id)!;
	expect(rec.options.routing?.routedModel).toBe("opus");
	await mgr.stop();
});

test("gate ON, apply mode, but taskClass has NO seeded evidence: falls through to default (no shift)", async () => {
	const { mgr, repo } = await makeMgr("route-thin");
	// No seedOutcomes call at all — empty matrix for every taskClass.
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
	const dto = await mgr.create(createOpts(repo, "thin"));
	expect(dto.model).toBeUndefined();
	await mgr.stop();
});

test("gate ON, apply mode: an explicit opts.model is NEVER overridden even with strong shift evidence", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-explicit");
	await seedStrongShiftEvidence(stateDir);
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
	const dto = await mgr.create(createOpts(repo, "explicit", { model: "haiku" }));
	expect(dto.model).toBe("haiku"); // operator's explicit choice stands, untouched
	await mgr.stop();
});

test("adw-factory-borrows concern 09: an operator-sourced lane's OWN flag widens apply past a GLOBAL shadow default", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-lane-widen");
	await seedStrongShiftEvidence(stateDir);
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	// OMP_SQUAD_MODEL_ROUTE_SHADOW intentionally left unset ⇒ the fleet-wide default is shadow — the
	// ONLY way to apply here is the lane's own widened flag.
	const dto = await withLaneApplyEnabled("hotfix", () => mgr.create(createOpts(repo, "lane-widen", { lane: "hotfix" })));
	expect(dto.model).toBe("opus");
	await mgr.stop();
});

test("adw-factory-borrows concern 09: a label/classifier-sourced lane can NEVER widen past a global shadow default", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-lane-widen-clamped");
	await seedStrongShiftEvidence(stateDir);
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	// Same lane, same flipped flag as the test above — but sourced from a Plane label (issue.lane),
	// not the operator, so the clamp must strip the widen and this stays shadow.
	const dto = await withLaneApplyEnabled("hotfix", () =>
		mgr.create(createOpts(repo, "lane-widen-clamped", { issue: { id: "i-lane-widen", name: "revert the outage", lane: "hotfix" }, autoRoute: false })),
	);
	expect(dto.model).toBeUndefined();
	await mgr.stop();
});

test("per-lane minEdge override (adw-factory-borrows concern 09): hotfix's lowered floor shifts on an edge the shared floor would reject", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-min-edge");
	// Edge 0.10: clears hotfix's lane-derived floor (0.08) but not the shared MIN_EDGE (0.15).
	await seedOutcomes(stateDir, "tdd", "heavy", "claude-sonnet-5", 20, 9); // 0.45
	await seedOutcomes(stateDir, "tdd", "heavy", "claude-opus-4-8", 20, 11); // 0.55
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
	const dto = await mgr.create(createOpts(repo, "min-edge", { lane: "hotfix" }));
	expect(dto.model).toBe("opus");
	await mgr.stop();
});
