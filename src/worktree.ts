/**
 * Git worktree helpers. Each managed agent runs in its own worktree so
 * parallel agents never fight over the same working tree.
 */

import { resolveStateDir } from "./state-dir.ts";
import * as path from "node:path";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";
import { existsSync, symlinkSync } from "node:fs";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runGit(args: string[], cwd?: string): Promise<GitResult> {
	// ponytail: untrusted repo config can exec code via core.fsmonitor/diff.external/hooks/pager — these neutralize it.
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], {
		cwd,
		env: { ...process.env, ...GIT_HARDEN_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Injectable git runner — lets tests drive worktree logic without a real repo. Defaults to `runGit`. */
export type GitRunner = (args: string[], cwd?: string) => Promise<GitResult>;

/** Resolve the git repository root containing `cwd`, or throw. */
export async function repoRoot(cwd: string, run: GitRunner = runGit): Promise<string> {
	const r = await run(["rev-parse", "--show-toplevel"], cwd);
	if (r.code !== 0) throw new Error(`not a git repository: ${cwd}${r.stderr ? ` (${r.stderr})` : ""}`);
	return r.stdout;
}

/** Base directory for squad-managed worktrees: `<stateDir>/worktrees` (see state-dir.ts). */
export function worktreeBase(): string {
	return path.join(resolveStateDir(), "worktrees");
}

async function branchExists(repo: string, branch: string, run: GitRunner = runGit): Promise<boolean> {
	const r = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
	return r.code === 0;
}

export interface CreatedWorktree {
	worktree: string;
	branch: string;
	repo: string;
}

// Transient git contention — index.lock / ref lock / a concurrent `worktree add` racing under fleet
// load. Safe to retry. A genuine failure (bad branch, path conflict, corruption) won't match → fails fast.
const TRANSIENT_LOCK = /lock|unable to create|cannot lock|already (exists|locked)|another git process/i;
const RETRY_DELAYS_MS = [100, 300]; // ponytail: 3 attempts (2 backoffs); fleet lock contention clears in ms

/**
 * Create (or reuse) a worktree for `repo` checked out to `branch`.
 * If the branch exists it is checked out; otherwise it is created off HEAD.
 */
export async function addWorktree(opts: {
	repo: string;
	branch: string;
	dir?: string;
	/** Worktree base dir override (org-scoped in DB mode). Default: worktreeBase(). */
	base?: string;
}, run: GitRunner = runGit): Promise<CreatedWorktree> {
	const repo = await repoRoot(opts.repo, run);
	const safe = opts.branch.replace(/[^a-zA-Z0-9._-]/g, "-");
	const dir = opts.dir ?? path.join(opts.base ?? worktreeBase(), `${path.basename(repo)}-${safe}`);

	// Already registered as a worktree at this path? Reuse it.
	const list = await run(["worktree", "list", "--porcelain"], repo);
	if (list.code === 0 && list.stdout.includes(`worktree ${dir}\n`)) {
		return { worktree: dir, branch: opts.branch, repo };
	}

	const exists = await branchExists(repo, opts.branch, run);
	const args = exists
		? ["worktree", "add", dir, opts.branch]
		: ["worktree", "add", "-b", opts.branch, dir];
	// Retry transient lock contention (index/ref locks under fleet load); fail fast on anything else.
	let r = await run(args, repo);
	for (let attempt = 0; r.code !== 0 && attempt < RETRY_DELAYS_MS.length && TRANSIENT_LOCK.test(`${r.stderr}\n${r.stdout}`); attempt++) {
		await Bun.sleep(RETRY_DELAYS_MS[attempt]);
		r = await run(args, repo);
	}
	if (r.code !== 0) {
		throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
	}
	// Provision node_modules so the worktree can run the repo's verify gate (tsc/test). A symlink to
	// the parent repo's install is gitignored, so it never lands in a commit.
	const nm = path.join(dir, "node_modules");
	if (existsSync(path.join(repo, "node_modules")) && !existsSync(nm)) {
		try { symlinkSync(path.join(repo, "node_modules"), nm, "dir"); } catch {}
	}
	return { worktree: dir, branch: opts.branch, repo };
}

/** True when `dir` is inside a git repository. Decides whether a failed worktree creation may fall
 *  back to running in-place: only a NON-git target dir is allowed to. */
export async function isGitRepo(dir: string, run: GitRunner = runGit): Promise<boolean> {
	try {
		await repoRoot(dir, run);
		return true;
	} catch {
		return existsSync(path.join(dir, ".git"));
	}
}

export interface ResolvedWorktree {
	cwd: string;
	repo: string;
	branch?: string;
	/** true ⇒ no isolation: the agent runs in `repo` itself (only ever a non-git "spawn anywhere" dir). */
	inPlace: boolean;
}

/**
 * Resolve an agent's working dir. Normally an isolated worktree; if `addWorktree` fails, a NON-git
 * target keeps the intentional "spawn anywhere" in-place fallback, but a real git checkout re-throws
 * — running in-place there would mutate the shared working tree (OMPSQ-40). `add`/`gitProbe` are
 * injectable so the policy is unit-testable without a real repo.
 */
export async function resolveWorktree(
	repo: string,
	branch: string,
	add: typeof addWorktree = addWorktree,
	gitProbe: typeof isGitRepo = isGitRepo,
	base?: string,
): Promise<ResolvedWorktree> {
	try {
		const wt = await add({ repo, branch, base });
		return { cwd: wt.worktree, repo: wt.repo, branch: wt.branch, inPlace: false };
	} catch (err) {
		if (await gitProbe(repo)) throw err;
		return { cwd: repo, repo, branch: undefined, inPlace: true };
	}
}

/** Remove a worktree (and prune the admin entry). Best-effort. */
export async function removeWorktree(repo: string, worktree: string): Promise<void> {
	const root = await repoRoot(repo).catch(() => repo);
	const r = await runGit(["worktree", "remove", "--force", worktree], root);
	if (r.code !== 0) {
		// Fall back to prune if the directory was already gone.
		await runGit(["worktree", "prune"], root);
	}
}

/** Current branch + short status for a worktree (for presence/collision metadata). */
export async function worktreeStatus(worktree: string): Promise<{ branch?: string; dirtyFiles: string[] }> {
	const branchR = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
	const statusR = await runGit(["status", "--porcelain"], worktree);
	const dirtyFiles =
		statusR.code === 0 && statusR.stdout
			? statusR.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean)
			: [];
	return { branch: branchR.code === 0 ? branchR.stdout : undefined, dirtyFiles };
}

/** Every worktree of `repo` (porcelain). The first entry git lists is always the primary checkout. */
export async function listWorktrees(repo: string): Promise<{ worktree: string; branch?: string; isPrimary: boolean }[]> {
	const root = await repoRoot(repo).catch(() => repo);
	const r = await runGit(["worktree", "list", "--porcelain"], root);
	if (r.code !== 0) return [];
	const out: { worktree: string; branch?: string; isPrimary: boolean }[] = [];
	let cur: { worktree?: string; branch?: string } = {};
	const flush = (): void => {
		if (cur.worktree) out.push({ worktree: cur.worktree, branch: cur.branch, isPrimary: out.length === 0 });
		cur = {};
	};
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			cur.worktree = line.slice("worktree ".length).trim();
		} else if (line.startsWith("branch ")) {
			cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		}
	}
	flush();
	return out;
}

/** Commits on `branch` not reachable from `base` (0 ⇒ fully merged/empty; -1 ⇒ couldn't determine). */
export async function branchAhead(repo: string, branch: string, base: string): Promise<number> {
	const r = await runGit(["rev-list", "--count", `${base}..${branch}`], repo);
	return r.code === 0 ? Number(r.stdout) || 0 : -1;
}

/** The repo's primary branch (the main checkout's current branch); falls back to "main". */
export async function primaryBranch(repo: string): Promise<string> {
	const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repo);
	return r.code === 0 && r.stdout && r.stdout !== "HEAD" ? r.stdout : "main";
}

/** Commit all changes in a worktree to its current branch (preserve abandoned WIP). Best-effort; true on commit. */
export async function commitWorktreeWip(worktree: string, message: string): Promise<boolean> {
	if ((await runGit(["add", "-A"], worktree)).code !== 0) return false;
	return (await runGit(["commit", "--no-verify", "-m", message], worktree)).code === 0;
}

/** Delete a branch only if it is fully merged — git's `-d` refuses an unmerged branch. Best-effort; true on delete. */
export async function deleteBranchIfMerged(repo: string, branch: string): Promise<boolean> {
	const root = await repoRoot(repo).catch(() => repo);
	return (await runGit(["branch", "-d", branch], root)).code === 0;
}
