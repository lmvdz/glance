/**
 * Convergence-run entrypoint (Epic 7, leaf 05) — exercises `runConvergence` (the exported function
 * behind the `bun src/convergence-run.ts --goal <id> [--fixture]` CLI) directly, covering both the
 * `--fixture` end-to-end path and the real Epic 1/3 adapters against an ad-hoc plan dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { armPath, failuresPath, isArmed, readFailures, readOracle, writeFailures, writeOracle } from "../src/convergence-oracle.ts";
import { gitDiffAgainstHead, gitDiffSinceBase, runConvergence, runOnceIteration } from "../src/convergence-run.ts";
import type { VerifiedState } from "../src/types.ts";

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

describe("runOnceIteration --once (S2 — the hook-driven single step)", () => {
	function oracle(overrides: Partial<VerifiedState> = {}): VerifiedState {
		return {
			goalId: "demo",
			iteration: 5,
			gap: 4,
			epsilon: 0,
			pendingEscalation: false,
			budget: { spent: 5, cap: 50 },
			decision: "continue",
			updatedAt: 0,
			...overrides,
		};
	}

	test("advances the oracle by EXACTLY one iteration against the current on-disk state", async () => {
		await withStateDir(async (dir) => {
			await writeOracle(oracle({ iteration: 5 }), dir);
			const next = await runOnceIteration({ goal: "demo", fixture: true, once: true });
			expect(next.iteration).toBe(6);
			expect(next.decision).toBe("continue"); // fixture gap 3 > epsilon 0
			expect((await readOracle(dir))?.iteration).toBe(6);
		});
	});

	test("is idempotent w.r.t. the hook contract: an already-terminal oracle advances nothing and disarms", async () => {
		await withStateDir(async (dir) => {
			await writeOracle(oracle({ iteration: 9, gap: 0, decision: "converged" }), dir);
			const result = await runOnceIteration({ goal: "demo", fixture: true, once: true });
			expect(result.iteration).toBe(9); // unchanged
			expect(result.decision).toBe("converged");
			expect(isArmed(dir)).toBe(false); // cleaned up
		});
	});

	test("seeds a fresh continuable state when no oracle exists yet, then advances by one", async () => {
		await withStateDir(async (dir) => {
			const next = await runOnceIteration({ goal: "demo", fixture: true, once: true });
			expect(next.iteration).toBe(1);
			expect((await readOracle(dir))?.iteration).toBe(1);
		});
	});

	test("keeps the sentinel armed (identity-stamped) between turns so the next Stop hook can still block", async () => {
		await withStateDir(async (dir) => {
			const prevSession = process.env.OMP_SQUAD_LOOP_SESSION;
			process.env.OMP_SQUAD_LOOP_SESSION = "session-A";
			try {
				await writeOracle(oracle({ iteration: 2 }), dir);
				await runOnceIteration({ goal: "demo", fixture: true, once: true });
				expect(isArmed(dir)).toBe(true);
				expect(readFileSync(armPath(dir), "utf8")).toBe("session-A"); // identity carried for the hook's match
			} finally {
				if (prevSession === undefined) delete process.env.OMP_SQUAD_LOOP_SESSION;
				else process.env.OMP_SQUAD_LOOP_SESSION = prevSession;
			}
		});
	});

	// Reproduce-first (eap-borrows finding #16): the OLD `readFailures` collapsed "corrupt sidecar"
	// into the SAME `null` as "no prior turn", so a corrupt sidecar silently became this turn's fresh
	// baseline — `runIteration` ran normally and, worse, `writeFailures` below would have overwritten
	// the (unreadable, but possibly still forensically useful) corrupt file with this turn's own set.
	test("(#16) a corrupt failures sidecar escalates WITHOUT running an iteration — oracle untouched-but-escalated, sidecar left for inspection", async () => {
		await withStateDir(async (dir) => {
			await writeOracle(oracle({ iteration: 5, gap: 4 }), dir);
			writeFileSync(failuresPath(dir), "{ not json at all");
			const next = await runOnceIteration({ goal: "demo", fixture: true, once: true });
			expect(next.decision).toBe("escalate");
			expect(next.pendingEscalation).toBe(true);
			expect(next.iteration).toBe(5); // untouched — runIteration never ran (plan/dispatch/validate skipped)
			expect(isArmed(dir)).toBe(false);
			// left on disk untouched — never silently repaired/overwritten/cleared.
			expect(readFileSync(failuresPath(dir), "utf8")).toBe("{ not json at all");
		});
	});

	test("disarms when an iteration reaches a terminal decision (budget cap)", async () => {
		await withStateDir(async (dir) => {
			const prevCap = process.env.OMP_SQUAD_CONVERGENCE_BUDGET_CAP;
			process.env.OMP_SQUAD_CONVERGENCE_BUDGET_CAP = "3";
			try {
				await writeOracle(oracle({ iteration: 2, budget: { spent: 2, cap: 3 } }), dir);
				const next = await runOnceIteration({ goal: "demo", fixture: true, once: true });
				expect(next.decision).toBe("budget-exhausted");
				expect(isArmed(dir)).toBe(false);
			} finally {
				if (prevCap === undefined) delete process.env.OMP_SQUAD_CONVERGENCE_BUDGET_CAP;
				else process.env.OMP_SQUAD_CONVERGENCE_BUDGET_CAP = prevCap;
			}
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

	// Reproduce-first (eap-borrows finding #15): the OLD `suiteFailures` mapped a suite that
	// demonstrably never ran (here: bash's own "command not found", exit 127) to `[]` — indistinguishable
	// from "the suite ran and found nothing wrong". The ratchet would then read "no known regressions"
	// for a turn that verified NOTHING.
	test("(#15) a suite that demonstrably never ran (exit 127) escalates and SKIPS the sidecar write — the prior REAL set survives untouched", async () => {
		await withStateDir(async (dir) => {
			const repo = tmpRepo();
			const planDir = path.join(repo, "plans", "demo");
			mkdirSync(planDir, { recursive: true });
			writeFileSync(path.join(planDir, "01-example.md"), "STATUS: open\nPRIORITY: p1\n\n# Example\n\n## Acceptance Criteria\n- something works\n");
			writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "definitely-not-a-real-binary-xyz-127" } }));
			writeFileSync(path.join(repo, "bun.lock"), "");
			await writeFailures(["prior.test.ts > z"], dir); // a REAL prior turn's failure set
			try {
				const terminal = await runOnceIteration({ goal: "demo", fixture: false, once: true }, repo);
				expect(terminal.decision).toBe("escalate");
				expect(terminal.pendingEscalation).toBe(true);
				// the write was SKIPPED entirely — the sidecar still holds the prior REAL set, never a
				// synthetic `[]` that would poison the next turn's set-diff into a false regression.
				expect(await readFailures(dir)).toEqual(["prior.test.ts > z"]);
			} finally {
				rmSync(repo, { recursive: true, force: true });
			}
		});
	});
});

describe("gitDiffSinceBase (Sentinel v0 mid-run drift-confirm diff — review fix #1)", () => {
	// Real git in tmp dirs, mirroring tests/validator-land-gate.test.ts's own convention.
	const tmps: string[] = [];
	afterEach(async () => {
		for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	});

	async function tmpGitDir(prefix: string): Promise<string> {
		const d = await fs.mkdtemp(path.join(tmpdir(), prefix));
		tmps.push(d);
		return d;
	}

	async function git(cwd: string, ...a: string[]): Promise<void> {
		await Bun.spawn(["git", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
	}

	/** A base repo with one commit, plus a worktree on a branch forked from it that TRACKS the base
	 *  branch as its upstream (`branch.<name>.merge` — mirrors a squad worktree forked from
	 *  origin/main) — enough to exercise `gitDiffSinceBase`'s merge-base resolution without a real
	 *  remote. The worktree gets one COMMITTED change (simulating incremental agent commits) plus one
	 *  UNCOMMITTED edit on top (simulating in-flight work) — `gitDiffSinceBase` must surface both. */
	async function repoWithTrackedWorktree(prefix: string): Promise<{ worktree: string }> {
		const repo = await tmpGitDir(prefix);
		await git(repo, "init", "-q", "-b", "main");
		await git(repo, "config", "user.email", "t@t");
		await git(repo, "config", "user.name", "t");
		await git(repo, "config", "commit.gpgsign", "false");
		await fs.writeFile(path.join(repo, "base.txt"), `base ${prefix}\n`);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base");
		const worktree = path.join(await tmpGitDir(`${prefix}wt-`), "wt");
		await git(repo, "worktree", "add", "-q", "-b", "squad/unit", worktree, "main");
		// Simulate the fork tracking its base branch (a real squad worktree forks from origin/main,
		// which @{u} resolves the same way) — without this, @{u} is unset and gitDiffSinceBase falls back.
		await git(repo, "branch", "--set-upstream-to=main", "squad/unit");
		await fs.writeFile(path.join(worktree, "feature.txt"), "committed change since fork\n");
		await git(worktree, "add", "-A");
		await git(worktree, "commit", "-qm", "add feature (committed mid-run)");
		await fs.appendFile(path.join(worktree, "feature.txt"), "uncommitted edit in flight\n");
		return { worktree };
	}

	test("with a tracked upstream, returns BOTH the committed-since-fork change AND the uncommitted edit", async () => {
		const { worktree } = await repoWithTrackedWorktree("gdsb-tracked-");
		const diff = await gitDiffSinceBase(worktree);
		// Both lines show up as ADDED ("+") content relative to the merge-base — the committed commit's
		// line is new territory since the fork, exactly like the still-uncommitted edit.
		expect(diff).toContain("+committed change since fork"); // committed commit since the fork point
		expect(diff).toContain("+uncommitted edit in flight"); // still-uncommitted working-tree edit
		// The exact bug this fixes: gitDiffAgainstHead (git diff HEAD) sees ONLY the uncommitted edit —
		// once the agent commits, the committed line is already part of HEAD, so it shows up (if at all)
		// as unchanged DIFF CONTEXT, never as an added "+" line.
		const uncommittedOnly = await gitDiffAgainstHead(worktree);
		expect(uncommittedOnly).not.toContain("+committed change since fork");
		expect(uncommittedOnly).toContain("+uncommitted edit in flight");
	});

	test("without a resolvable upstream, falls back to the uncommitted-only diff (never empty-by-surprise)", async () => {
		const repo = await tmpGitDir("gdsb-fallback-");
		await git(repo, "init", "-q", "-b", "main");
		await git(repo, "config", "user.email", "t@t");
		await git(repo, "config", "user.name", "t");
		await git(repo, "config", "commit.gpgsign", "false");
		await fs.writeFile(path.join(repo, "base.txt"), "base\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "base");
		// No upstream, no origin/HEAD configured — @{u} and origin/HEAD both fail to resolve.
		await fs.writeFile(path.join(repo, "base.txt"), "base\nuncommitted-only change\n");
		const diff = await gitDiffSinceBase(repo);
		expect(diff).toContain("uncommitted-only change");
		expect(diff).toEqual(await gitDiffAgainstHead(repo)); // identical to the documented fallback
	});

	test("never throws on an unreadable / non-git directory — degrades to empty", async () => {
		const notGit = await tmpGitDir("gdsb-notgit-");
		await expect(gitDiffSinceBase(notGit)).resolves.toBe("");
		await expect(gitDiffSinceBase("/path/does/not/exist-at-all")).resolves.toBe("");
	});
});
