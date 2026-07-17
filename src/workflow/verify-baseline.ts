/**
 * Base-diff provider for the per-unit verify gate (postmortem-gate-fixes): computes the verify
 * command's failing set on the unit's BASE state, so `runCommand` (executor.ts) can tell a
 * pre-existing red baseline (flaky test, stale-shared-node_modules env failure — already broken
 * before this unit touched anything) from a failure the unit's OWN diff introduced. Mirrors the
 * land-time regression gate's base-vs-merged comparison (`applyRegressionGate` in `../land.ts`)
 * one level down, at the per-unit verify node instead of the post-merge full suite.
 *
 * The base run must never disturb the unit's dirty worktree — there may be uncommitted edits the
 * unit hasn't landed yet, and a `git checkout`/`stash` dance here could lose them mid-verify. A
 * throwaway DETACHED git worktree at the base commit sidesteps that entirely: the unit's own
 * worktree is never touched, and the scratch worktree is removed in a `finally` regardless of
 * outcome.
 *
 * Fail-closed by construction: any step that can't establish a trustworthy base run (worktree
 * creation fails, the base gate itself is unrunnable — command-not-found, degraded sandbox, zero
 * tests executed) returns a non-null `unrunnable` reason instead of an empty failing set. Reading
 * "could not determine the base" as "the base is clean" would silently flip a real regression to
 * always-allow — the same fail-open shape `applyRegressionGate` guards against upstream (see the
 * `gateRunUnrunnable` cross-lineage-review comment in `../gate-runner.ts`).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gateRunUnrunnable } from "../gate-runner.ts";
import { extractGateFailures } from "../land.ts";

export interface CommandRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface BaselineProviderDeps {
	/** The unit's worktree (executor cwd) — the base run is derived from here but never mutates it. */
	worktree: string;
	/** Runs the gate command in a given cwd; same shape as the executor's execCommand. */
	exec: (script: string, cwd: string) => Promise<CommandRunResult>;
	/** Runs a git command; returns {code, stdout, stderr}. Inject a fake in tests. */
	git: (args: string[], cwd: string) => Promise<CommandRunResult>;
	/** Make a unique temp dir path (default: os.tmpdir + random). Injectable for tests. */
	mkTmpDir?: () => string;
	/** Optional log sink (cleanup/symlink failures are best-effort and otherwise silent). */
	log?: (msg: string) => void;
}

export interface BaselineResult {
	failures: string[];
	unrunnable: string | null;
	baseRef: string;
}

function defaultMkTmpDir(): string {
	return path.join(os.tmpdir(), `glance-verify-base-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

/** Default branch name the unit's branch forked from: origin/HEAD's target, else main/master (first that exists). */
async function resolveDefaultBranch(git: BaselineProviderDeps["git"], cwd: string): Promise<string | undefined> {
	const sym = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
	if (sym.code === 0) {
		const ref = sym.stdout.trim();
		const stripped = ref.replace(/^refs\/remotes\/origin\//, "");
		if (stripped && stripped !== ref) return stripped;
	}
	for (const candidate of ["main", "master"]) {
		const check = await git(["rev-parse", "--verify", candidate], cwd);
		if (check.code === 0) return candidate;
	}
	return undefined;
}

/**
 * The commit the unit's branch forked from, so both uncommitted AND already-committed unit edits
 * are excluded from the base run. Falls back to HEAD when no default branch is resolvable or
 * merge-base fails — a unit with only uncommitted edits has HEAD==base already, and a detached
 * worktree at HEAD excludes the working-tree edits (git worktree add only checks out the commit,
 * never the dirty index/worktree state), which is exactly the base state in that case too.
 */
async function resolveBaseSha(deps: BaselineProviderDeps): Promise<string> {
	const { git, worktree } = deps;
	const defaultBranch = await resolveDefaultBranch(git, worktree);
	if (defaultBranch) {
		const mb = await git(["merge-base", "HEAD", defaultBranch], worktree);
		if (mb.code === 0 && mb.stdout.trim()) return mb.stdout.trim();
	}
	const head = await git(["rev-parse", "HEAD"], worktree);
	return head.stdout.trim();
}

/** Walk `node_modules` up the tree from `start`, returning the first that exists (bun-style resolution). */
async function findNodeModulesUpTree(start: string): Promise<string | undefined> {
	let dir = path.resolve(start);
	for (;;) {
		const candidate = path.join(dir, "node_modules");
		const exists = await fs
			.access(candidate)
			.then(() => true)
			.catch(() => false);
		if (exists) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Build a MEMOIZED baseline-failure provider: the returned function runs the gate on the unit's
 * base state via a throwaway detached worktree and returns its failing set. The underlying base
 * run executes at most ONCE per provider instance (the Promise itself is memoized, not just its
 * resolved value) — repeated verify failures within one workflow run (retry loop: verify → codefix
 * → verify → …) all await the SAME base run instead of paying for a fresh one every time.
 */
export function makeBaselineFailureProvider(deps: BaselineProviderDeps): (script: string) => Promise<BaselineResult | null> {
	const { worktree, exec, git, mkTmpDir = defaultMkTmpDir, log } = deps;
	let memo: Promise<BaselineResult | null> | undefined;

	async function runOnce(script: string): Promise<BaselineResult | null> {
		let baseRef = "";
		try {
			baseRef = await resolveBaseSha(deps);
			const tmpDir = mkTmpDir();
			const add = await git(["worktree", "add", "--detach", tmpDir, baseRef], worktree);
			if (add.code !== 0) {
				return { failures: [], unrunnable: `could not create base worktree: ${(add.stderr || add.stdout).trim()}`, baseRef };
			}
			try {
				const nodeModules = await findNodeModulesUpTree(worktree);
				if (nodeModules) {
					await fs.symlink(nodeModules, path.join(tmpDir, "node_modules")).catch((err) => {
						log?.(`[base-diff] could not symlink node_modules into base worktree: ${err instanceof Error ? err.message : String(err)}`);
					});
				}
				const run = await exec(script, tmpDir);
				const output = [run.stdout, run.stderr].filter((s) => s.trim()).join("\n").trim();
				const unrunnable = run.code !== 0 ? (gateRunUnrunnable({ code: run.code, output }, script) ?? null) : null;
				const failures = run.code !== 0 ? extractGateFailures(output) : [];
				return { failures, unrunnable, baseRef };
			} finally {
				const rm = await git(["worktree", "remove", "--force", tmpDir], worktree).catch((err) => ({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
				if (rm.code !== 0) log?.(`[base-diff] git worktree remove failed for ${tmpDir}: ${rm.stderr}`);
				await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
					log?.(`[base-diff] could not remove scratch dir ${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
				});
			}
		} catch (err) {
			return { failures: [], unrunnable: `base run threw: ${err instanceof Error ? err.message : String(err)}`, baseRef };
		}
	}

	return (script: string) => {
		if (!memo) memo = runOnce(script);
		return memo;
	};
}
