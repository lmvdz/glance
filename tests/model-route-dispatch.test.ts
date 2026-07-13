/**
 * Route-at-dispatch wiring (model-routing-control-loop concern 06) — exercises the ACTUAL
 * `SquadManager.createWithId` call site, not just the pure `routeModelForTaskClass` function
 * (see model-route.test.ts for that). Verifies:
 *   - gate OFF (`OMP_SQUAD_MODEL_OUTCOMES` unset) ⇒ zero behavior change, even with strong seeded
 *     evidence that WOULD shift if the gate were on.
 *   - gate ON, shadow default ⇒ decision logged/recorded but NOT applied (`opts.model` untouched).
 *   - gate ON, `OMP_SQUAD_MODEL_ROUTE_SHADOW=0` (apply mode) ⇒ the chosen model lands on the DTO.
 *   - thin/no-data taskClass ⇒ no shift even in apply mode.
 *   - an explicit `opts.model` is never overridden, gate on or off.
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
import { SquadManager } from "../src/squad-manager.ts";
import { recordTaskOutcome } from "../src/task-outcomes.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

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

test("gate ON, apply mode (SHADOW=0): the chosen frontier model lands on the DTO", async () => {
	const { mgr, repo, stateDir } = await makeMgr("route-apply");
	await seedStrongShiftEvidence(stateDir);
	process.env.OMP_SQUAD_MODEL_OUTCOMES = "1";
	process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
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
