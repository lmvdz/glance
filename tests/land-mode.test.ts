/**
 * Land-mode probe (concern 05). Each of the 5 probes is exercised independently over a REAL git
 * repo + a real bare "origin" remote (no network) — only `gh` itself is mocked (module-mock, since
 * there is no real GitHub repo to probe against in a test environment; git.ts's own `hardenedGit`
 * calls run for real, mirroring the "real git in a tmp dir, no mocks" convention used elsewhere for
 * the git-only pieces of this codebase).
 */

import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// One shared, mutable mock — reassigned per test instead of re-registering mock.module (which only
// needs to happen once, before the module under test is (dynamically) imported).
let ghResponse: { defaultBranchRef?: { name: string } } | undefined = { defaultBranchRef: { name: "main" } };
mock.module("../src/gh.ts", () => ({
	gh: async () => ({ code: 0, stdout: "", stderr: "" }),
	ghJson: async () => ghResponse,
	ghAvailable: async () => true,
}));

const { resolveLandMode, aheadOfBase } = await import("../src/land-mode.ts");

const ENV_KEYS = ["OMP_SQUAD_LAND_MODE", "OMP_SQUAD_PR_BASE", "OMP_SQUAD_LAND_MODE_TTL_MS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	ghResponse = { defaultBranchRef: { name: "main" } };
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	return repo;
}

async function commit(repo: string, file: string, content: string, message: string): Promise<void> {
	await fs.writeFile(path.join(repo, file), content);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
}

/** A bare "origin" remote. */
async function bareRepo(prefix: string): Promise<string> {
	const dir = await tmpDir(prefix);
	await git(dir, "init", "-q", "--bare");
	return dir;
}

/** A repo on `main`, with one commit, pushed to a fresh bare origin — "all probes pass" baseline. */
async function convergedRepo(prefix: string): Promise<string> {
	const repo = await gitRepo(prefix);
	await commit(repo, "a.txt", "a\n", "base");
	const origin = await bareRepo(`${prefix}origin-`);
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "main");
	return repo;
}

// ── probe 1: no parseable owner/repo ────────────────────────────────────────────────────────────

test("probe 1: no origin configured ⇒ local, reason names the unparseable identity", async () => {
	const repo = await gitRepo("lm-noorigin-");
	await commit(repo, "a.txt", "a\n", "base");
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("local");
	expect(resolved.reason).toContain("no parseable owner/repo from origin");
});

// ── probe 2: gh repo view fails / no default branch ─────────────────────────────────────────────

test("probe 2: gh reports no default branch ⇒ local", async () => {
	const repo = await gitRepo("lm-nodefault-");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "remote", "add", "origin", "git@github.com:acme/repo-xyz.git");
	ghResponse = undefined; // gh repo view failed / no defaultBranchRef
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("local");
	expect(resolved.reason).toContain("gh repo view acme/repo-xyz failed or has no default branch");
});

// ── probe 3: git push --dry-run fails ───────────────────────────────────────────────────────────

test("probe 3: push --dry-run fails (unreachable origin) ⇒ local", async () => {
	const repo = await gitRepo("lm-nopush-");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "remote", "add", "origin", path.join(os.tmpdir(), "lm-does-not-exist-xyz"));
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("local");
	expect(resolved.reason).toContain("git push --dry-run origin HEAD:refs/heads/squad/push-probe failed");
});

// ── regression: BEHIND origin is the NORMAL PR-mode state, not a push failure ───────────────────

test("probe 3 regression: local behind origin (normal PR-mode state) still resolves pr, not local", async () => {
	const repo = await convergedRepo("lm-behind-");
	// Advance ORIGIN without the local checkout ever seeing it — simulates a PR merged on GitHub while
	// this checkout hasn't been ff-healed yet. A naive `git push --dry-run origin main` from `repo`
	// would reject this as non-fast-forward even though local is a clean ancestor of origin (probe 5
	// already tolerates exactly this). The probe-ref write probe must not trip on it.
	const originUrl = (await git(repo, "remote", "get-url", "origin")).stdout;
	const clonesRoot = await tmpDir("lm-behind-clones-");
	const clone = path.join(clonesRoot, "clone");
	await git(clonesRoot, "clone", "-q", originUrl, clone);
	await git(clone, "config", "user.email", "t@t");
	await git(clone, "config", "user.name", "t");
	await git(clone, "config", "commit.gpgsign", "false");
	await commit(clone, "b.txt", "b\n", "merged on github, not yet pulled locally");
	await git(clone, "push", "-q", "origin", "main");

	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("main");
});

// ── probe 4: checked-out branch is informational, never a gate ──────────────────────────────────

/**
 * THE INTERLOCK REGRESSION. The old probe 4 ("a deliberate non-default checkout always wins")
 * returned `local` here, and local mode's `landAgent` then refuses any repo with a dirty tree
 * (`land.ts`'s rollback blast-radius guard) with `retryable: true` — a refusal that retries forever
 * and never escalates. An operator working in the repo trips BOTH conditions, so the fleet could
 * never land while anyone was using it: 1381/1686 (82%) of all recorded land attempts died there.
 * A PR-mode unit never touches the shared checkout, so the operator's branch cannot make landing
 * unsafe — it is precisely the reason to prefer PR mode.
 */
test("probe 4: a non-default checkout no longer forces local — the fleet lands as PRs while the operator works", async () => {
	const repo = await convergedRepo("lm-branchmismatch-");
	await git(repo, "checkout", "-qb", "feature");
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("main");
	// The operator's branch is still reported — legibility, not a gate.
	expect(resolved.reason).toContain("operator on feature");
});

test("probe 4: a dirty working tree is irrelevant to the resolved mode (nothing merges into it)", async () => {
	const repo = await convergedRepo("lm-dirty-");
	await git(repo, "checkout", "-qb", "feature");
	await fs.writeFile(path.join(repo, "a.txt"), "locally modified, uncommitted\n");
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("pr");
});

// ── probe 5: the LOCAL DEFAULT BRANCH diverged from origin ──────────────────────────────────────

test("probe 5: local default has an unpushed commit ahead of origin ⇒ local, diverged", async () => {
	const repo = await convergedRepo("lm-diverged-");
	await commit(repo, "b.txt", "b\n", "unpushed"); // local main now ahead; origin/main lacks this commit
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("local");
	expect(resolved.reason).toContain("is NOT an ancestor of origin/main — diverged");
});

/** Probe 5 must read `refs/heads/<default>`, not HEAD: the divergence guard has to keep protecting an
 *  unpushed local `main` even when the operator is standing somewhere else. (Reading HEAD here would
 *  report the feature branch's divergence instead — always true — and re-force local mode.) */
test("probe 5: a DIVERGED local default still forces local even from a non-default checkout", async () => {
	const repo = await convergedRepo("lm-diverged-offbranch-");
	await commit(repo, "b.txt", "b\n", "unpushed on main");
	await git(repo, "checkout", "-qb", "feature"); // HEAD moves; refs/heads/main is still ahead of origin
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("local");
	expect(resolved.reason).toContain("local main is NOT an ancestor of origin/main");
});

/** Converse: a CONVERGED local default with the operator parked on a feature branch is the exact
 *  shape of this repo during normal use. It must resolve pr — that is the whole point of the fix. */
test("probe 5: a converged local default + non-default checkout ⇒ pr", async () => {
	const repo = await convergedRepo("lm-converged-offbranch-");
	await git(repo, "checkout", "-qb", "feature");
	await commit(repo, "b.txt", "b\n", "work on the feature branch only");
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("pr");
});

test("probe 5: no local <default> ref at all (cloned straight onto a branch) ⇒ pr, nothing to strand", async () => {
	const seed = await convergedRepo("lm-nolocaldefault-");
	const originUrl = (await git(seed, "remote", "get-url", "origin")).stdout;
	const clonesRoot = await tmpDir("lm-nolocaldefault-clones-");
	const clone = path.join(clonesRoot, "clone");
	await git(clonesRoot, "clone", "-q", originUrl, clone);
	await git(clone, "config", "user.email", "t@t");
	await git(clone, "config", "user.name", "t");
	await git(clone, "checkout", "-qb", "work");
	await git(clone, "branch", "-D", "main"); // no refs/heads/main remains

	const resolved = await resolveLandMode(clone, { landMode: "auto" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("main");
});

// ── all 5 pass ───────────────────────────────────────────────────────────────────────────────────

test("all 5 probes passing ⇒ pr mode with the resolved default branch", async () => {
	const repo = await convergedRepo("lm-allpass-");
	const resolved = await resolveLandMode(repo, { landMode: "auto" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("main");
	expect(resolved.reason).toContain("all 5 probes passed");
});

test("OMP_SQUAD_PR_BASE overrides gh's reported default branch", async () => {
	const repo = await gitRepo("lm-prbase-");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "branch", "-m", "trunk"); // rename so "trunk" is the actual local/remote branch
	const origin = await bareRepo("lm-prbase-origin-");
	await git(repo, "remote", "add", "origin", origin);
	await git(repo, "push", "-q", "origin", "trunk");
	ghResponse = { defaultBranchRef: { name: "wrong-branch" } }; // gh says one thing...
	// ...operator override says another, and wins. Passed explicitly (not via process.env) so a
	// sibling file mutating OMP_SQUAD_PR_BASE across an await can't bleed a different base in here.
	const resolved = await resolveLandMode(repo, { landMode: "auto", prBase: "trunk" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("trunk");
});

// ── OMP_SQUAD_LAND_MODE bypass ──────────────────────────────────────────────────────────────────

test("OMP_SQUAD_LAND_MODE=local bypasses the probe entirely", async () => {
	process.env.OMP_SQUAD_LAND_MODE = "local";
	const resolved = await resolveLandMode("/nonexistent/never/probed");
	expect(resolved).toEqual({ mode: "local", reason: "OMP_SQUAD_LAND_MODE=local" });
});

test("an explicit landMode override wins over process.env — the concurrency-safe input path", async () => {
	// Ambient env says one thing; the explicit override says another and MUST win. This is the seam
	// that immunizes callers from the cross-file env leak: the value comes from the argument, never
	// the process-global (so a sibling test mutating OMP_SQUAD_LAND_MODE mid-await cannot bleed in).
	process.env.OMP_SQUAD_LAND_MODE = "pr";
	const resolved = await resolveLandMode("/nonexistent/never/probed", { landMode: "local" });
	expect(resolved).toEqual({ mode: "local", reason: "OMP_SQUAD_LAND_MODE=local" });
});

test("OMP_SQUAD_LAND_MODE=pr bypasses the convergence probe, but still best-effort resolves a default branch via gh", async () => {
	const repo = await gitRepo("lm-forced-gh-");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "remote", "add", "origin", "git@github.com:acme/repo-xyz.git");
	ghResponse = { defaultBranchRef: { name: "main" } };
	const resolved = await resolveLandMode(repo, { landMode: "pr" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("main");
	expect(resolved.reason).toContain("forced");
});

test("OMP_SQUAD_LAND_MODE=pr forced: gh fails but origin/HEAD symref resolves the default branch", async () => {
	const repo = await convergedRepo("lm-forced-symref-");
	await git(repo, "remote", "set-head", "origin", "main"); // records refs/remotes/origin/HEAD locally
	ghResponse = undefined; // gh unreachable/unconfigured
	const resolved = await resolveLandMode(repo, { landMode: "pr" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBe("main");
});

test("OMP_SQUAD_LAND_MODE=pr forced with truly nothing resolvable (no origin at all) ⇒ pr mode with NO default branch, never silently local", async () => {
	const resolved = await resolveLandMode("/nonexistent/never/probed", { landMode: "pr" });
	expect(resolved.mode).toBe("pr");
	expect(resolved.defaultBranch).toBeUndefined();
	expect(resolved.reason).toContain("no default branch could be resolved");
});

// ── TTL cache ────────────────────────────────────────────────────────────────────────────────────

test("TTL cache: a resolution is reused within the window, re-probed after it expires", async () => {
	process.env.OMP_SQUAD_LAND_MODE_TTL_MS = "50";
	const repo = await convergedRepo("lm-ttl-");

	const first = await resolveLandMode(repo, { landMode: "auto" });
	expect(first.mode).toBe("pr"); // all probes pass initially

	// Break probe 5 (unpushed commit) WITHOUT letting the TTL window elapse — cache must win.
	await commit(repo, "b.txt", "b\n", "unpushed-during-ttl");
	const stillCached = await resolveLandMode(repo, { landMode: "auto" });
	expect(stillCached.mode).toBe("pr");
	expect(stillCached).toEqual(first);

	// Past the TTL window ⇒ re-probes and now sees the diverged state.
	await Bun.sleep(80);
	const reprobed = await resolveLandMode(repo, { landMode: "auto" });
	expect(reprobed.mode).toBe("local");
	expect(reprobed.reason).toContain("diverged");
});

// ── aheadOfBase ──────────────────────────────────────────────────────────────────────────────────

test("aheadOfBase in local mode matches the old HEAD..branch behavior exactly", async () => {
	const repo = await gitRepo("aob-local-");
	await commit(repo, "a.txt", "a\n", "base");
	await git(repo, "branch", "feat");
	// feat is 2 commits ahead of the (unmoved) HEAD/main.
	await git(repo, "checkout", "-q", "feat");
	await commit(repo, "b.txt", "b\n", "one");
	await commit(repo, "c.txt", "c\n", "two");
	await git(repo, "checkout", "-q", "main");

	expect(await aheadOfBase({ repo, branch: "feat", overrides: { landMode: "local" } })).toBe(2);
	expect(await aheadOfBase({ repo, branch: "main", overrides: { landMode: "local" } })).toBe(0);
});

test("aheadOfBase in pr mode counts against origin/<default>..branch, not local HEAD", async () => {
	const repo = await convergedRepo("aob-pr-");
	// A branch pushed to a worktree-like local branch, still unmerged into origin/main.
	await git(repo, "branch", "squad/feat");
	await git(repo, "checkout", "-q", "squad/feat");
	await commit(repo, "b.txt", "b\n", "one");
	await git(repo, "checkout", "-q", "main");

	// Advance LOCAL main (not pushed) so local-HEAD..branch would read differently than origin..branch,
	// proving the primitive is origin-aware, not just "whatever HEAD happens to be right now".
	await commit(repo, "local-only.txt", "x\n", "local main advances without pushing");

	const ahead = await aheadOfBase({ repo, branch: "squad/feat", overrides: { landMode: "auto" } });
	expect(ahead).toBe(1); // one commit ahead of origin/main, regardless of local main's unrelated advance
});

test("aheadOfBase returns 0 once a pr-mode branch is fully merged into origin/<default>", async () => {
	const repo = await convergedRepo("aob-pr-merged-");
	await git(repo, "branch", "squad/done");
	await git(repo, "checkout", "-q", "squad/done");
	await commit(repo, "d.txt", "d\n", "done work");
	await git(repo, "checkout", "-q", "main");
	await git(repo, "merge", "-q", "--no-ff", "-m", "merge squad/done", "squad/done");
	await git(repo, "push", "-q", "origin", "main"); // origin/main now contains squad/done's commit

	expect(await aheadOfBase({ repo, branch: "squad/done", overrides: { landMode: "auto" } })).toBe(0);
});
