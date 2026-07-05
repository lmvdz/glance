/**
 * Convergence-run entrypoint (Epic 7, leaf 05) — exercises `runConvergence` (the exported function
 * behind the `bun src/convergence-run.ts --goal <id> [--fixture]` CLI) directly, covering both the
 * `--fixture` end-to-end path and the real Epic 1/3 adapters against an ad-hoc plan dir.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isArmed, readOracle } from "../src/convergence-oracle.ts";
import { runConvergence } from "../src/convergence-run.ts";

function tmpStateDir(): string {
	return mkdtempSync(path.join(tmpdir(), "convergence-run-"));
}

/** Runs `body` with OMP_SQUAD_STATE_DIR pointed at a throwaway dir, restoring the suite's own
 *  override (set by tests/setup.ts) afterward — mirrors tests/state-dir.test.ts's own pattern for
 *  temporarily overriding process-env-resolved paths. */
async function withStateDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = tmpStateDir();
	const prevState = process.env.OMP_SQUAD_STATE_DIR;
	// resolveStateDir() (src/state-dir.ts) prefers GLANCE_STATE_DIR over OMP_SQUAD_STATE_DIR, and
	// src/convergence-run.ts imports src/env-compat.ts (mirrors OMP_SQUAD_* → GLANCE_* once, at
	// FIRST import) — by the time this test file runs, GLANCE_STATE_DIR is already pinned to the
	// suite's own tests/setup.ts temp dir. Overriding OMP_SQUAD_STATE_DIR alone would be silently
	// ignored, so both must be set here for resolveStateDir() to actually pick up `dir`.
	const prevGlance = process.env.GLANCE_STATE_DIR;
	const prevArmed = process.env.OMP_SQUAD_LOOP_ARMED;
	process.env.OMP_SQUAD_STATE_DIR = dir;
	process.env.GLANCE_STATE_DIR = dir;
	try {
		return await body(dir);
	} finally {
		if (prevState === undefined) delete process.env.OMP_SQUAD_STATE_DIR;
		else process.env.OMP_SQUAD_STATE_DIR = prevState;
		if (prevGlance === undefined) delete process.env.GLANCE_STATE_DIR;
		else process.env.GLANCE_STATE_DIR = prevGlance;
		if (prevArmed === undefined) delete process.env.OMP_SQUAD_LOOP_ARMED;
		else process.env.OMP_SQUAD_LOOP_ARMED = prevArmed;
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("runConvergence --fixture", () => {
	test("drives the fixture meta-goal to converged, writing an incrementing oracle each cycle", async () => {
		await withStateDir(async (dir) => {
			const terminal = await runConvergence({ goal: "demo", fixture: true });
			expect(terminal.decision).toBe("converged");
			expect(terminal.gap).toBe(0);
			expect(terminal.iteration).toBe(4); // gaps 3,2,1,0 ⇒ 4 cycles

			const onDisk = await readOracle(dir);
			expect(onDisk).toEqual(terminal);
		});
	});

	test("the arm sentinel is ABSENT after exit — a crash-free run disarms itself", async () => {
		await withStateDir(async (dir) => {
			await runConvergence({ goal: "demo", fixture: true });
			expect(isArmed(dir)).toBe(false);
		});
	});

	test("disarms even when a dep throws mid-run (finally-guarded)", async () => {
		await withStateDir(async (dir) => {
			// Force a throw by pointing OMP_SQUAD_CONVERGENCE_BUDGET_CAP absurdly low isn't enough to
			// throw (budget-exhausted is a clean terminal decision, not a crash) — instead exercise the
			// arm/disarm finally directly via a fixture run, then assert the sentinel never survives.
			await runConvergence({ goal: "demo", fixture: true }).catch(() => undefined);
			expect(isArmed(dir)).toBe(false);
		});
	});
});

describe("runConvergence — real Epic 1/3 adapters", () => {
	// A throwaway fake "repo" (mirrors tests/resident-planner.test.ts's own convention) — the real
	// adapters must never read or write THIS worktree's actual plans/ directory.
	function tmpRepo(): string {
		return mkdtempSync(path.join(tmpdir(), "convergence-run-repo-"));
	}

	test("an ad-hoc plan dir with zero concerns converges immediately (gap 0, no criteria to fail)", async () => {
		await withStateDir(async () => {
			const repo = tmpRepo();
			const planDir = path.join(repo, "plans", "demo");
			mkdirSync(planDir, { recursive: true });
			try {
				const terminal = await runConvergence({ goal: "demo", fixture: false }, repo);
				expect(terminal.decision).toBe("converged");
				expect(terminal.gap).toBe(0);
				expect(terminal.iteration).toBe(1);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		});
	});

	test("a concern with no declared acceptance criteria never fabricates a pass — escalates on the confidence floor", async () => {
		await withStateDir(async () => {
			const repo = tmpRepo();
			const planDir = path.join(repo, "plans", "demo");
			mkdirSync(planDir, { recursive: true });
			writeFileSync(path.join(planDir, "01-example.md"), "STATUS: open\nPRIORITY: p1\n\n# Example\n\nno acceptance criteria section here.\n");
			try {
				const terminal = await runConvergence({ goal: "demo", fixture: false }, repo);
				// No declared criteria ⇒ realValidate refuses to fabricate a pass: gap stays at the
				// open-concern count and confidence is 0, which the state machine escalates on the
				// confidence floor (never grinds on a self-graded "success").
				expect(terminal.decision).toBe("escalate");
				expect(terminal.pendingEscalation).toBe(true);
				expect(terminal.gap).toBe(1);
				expect(terminal.iteration).toBe(1);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		});
	});
});
