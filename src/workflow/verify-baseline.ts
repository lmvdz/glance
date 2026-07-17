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

async function refExists(git: BaselineProviderDeps["git"], cwd: string, ref: string): Promise<boolean> {
	return (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd)).code === 0;
}

/**
 * The ref to take the merge-base against — the point the unit's branch forked from.
 *
 * Prefer the REMOTE-tracking default (`origin/<default>`), NOT the local branch: fleet units fork from
 * `origin/<default>`, and a local `main` can be stale (behind origin). Diffing against a stale local
 * default that still contains a failure origin has since FIXED would read that failure as pre-existing
 * and wave a reintroduction through (codex review). Falls back to a local default only when no
 * remote-tracking ref exists; returns undefined (⇒ fail closed) when nothing resolves.
 */
async function resolveBaseTarget(git: BaselineProviderDeps["git"], cwd: string): Promise<string | undefined> {
	const sym = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
	if (sym.code === 0) {
		const remoteRef = sym.stdout.trim().replace(/^refs\/remotes\//, ""); // e.g. "origin/main"
		if (remoteRef && remoteRef !== sym.stdout.trim() && (await refExists(git, cwd, remoteRef))) return remoteRef;
	}
	for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
		if (await refExists(git, cwd, candidate)) return candidate;
	}
	return undefined;
}

/**
 * The commit the unit's branch forked from — the merge-base of HEAD and the default branch — so that
 * both uncommitted AND already-committed unit edits are excluded from the base run.
 *
 * Returns null (⇒ the caller fails CLOSED) when no default branch resolves or merge-base fails, rather
 * than falling back to HEAD. HEAD is a SAFE base only for a unit that hasn't committed (HEAD==base);
 * for a unit that already committed its edits, HEAD *includes* them, so diffing against it would fold
 * the unit's OWN new failures into the "base" set and wave a genuine regression through as
 * pre-existing (grok review: a fail-open). We cannot tell the two apart without a real fork point, so
 * an unresolvable base is treated as "could not establish a trustworthy base" — the gate then blocks
 * on the full failure set, exactly like the land-time regression gate's fail-closed stance.
 */
async function resolveBaseSha(deps: BaselineProviderDeps): Promise<string | null> {
	const { git, worktree } = deps;
	const baseTarget = await resolveBaseTarget(git, worktree);
	if (!baseTarget) return null;
	const mb = await git(["merge-base", "HEAD", baseTarget], worktree);
	if (mb.code !== 0 || !mb.stdout.trim()) return null;
	return mb.stdout.trim();
}

/**
 * True when the unit changed dependency manifests (package.json / bun.lock) relative to the base —
 * committed OR uncommitted. The base run SHARES the unit's installed node_modules (we symlink it, we
 * don't reinstall the base's deps), so a dependency-induced regression would appear in BOTH the base
 * and current runs and read as pre-existing (codex review). When deps changed we can't establish a
 * faithful base, so the caller fails closed and the full suite must pass. `git diff <ref> -- <paths>`
 * compares the ref to the WORKING TREE, catching committed and uncommitted manifest edits in one call.
 */
async function unitChangedDependencies(git: BaselineProviderDeps["git"], cwd: string, baseRef: string): Promise<boolean> {
	const diff = await git(["diff", "--name-only", baseRef, "--", "package.json", "bun.lock"], cwd);
	return diff.code === 0 && diff.stdout.trim().length > 0;
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

	async function runOnce(script: string): Promise<BaselineResult | null> {
		let baseRef = "";
		try {
			const resolved = await resolveBaseSha(deps);
			if (!resolved) {
				// No trustworthy fork point — fail CLOSED (the caller blocks on the full failure set) rather
				// than diff against a base that could already contain the unit's own committed edits.
				return { failures: [], unrunnable: "could not resolve a base ref (no default branch / merge-base)", baseRef: "" };
			}
			baseRef = resolved;
			if (await unitChangedDependencies(git, worktree, baseRef)) {
				// Deps changed → the base run would execute against the unit's NEW node_modules, so a
				// dependency-induced regression would look pre-existing. Fail closed (block on full suite).
				return { failures: [], unrunnable: "unit changed dependencies (package.json/bun.lock) — base-diff not applicable", baseRef };
			}
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

	// Memoize on the script: the base run executes at most once PER command. In practice the verify
	// goalGate always passes the same script, so this collapses the retry loop to a single base run;
	// keying on the script also means a hypothetical second command can't silently reuse the first's
	// result (grok review).
	const memoByScript = new Map<string, Promise<BaselineResult | null>>();
	return (script: string) => {
		let memo = memoByScript.get(script);
		if (!memo) {
			memo = runOnce(script);
			memoByScript.set(script, memo);
		}
		return memo;
	};
}
