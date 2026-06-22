/**
 * Git worktree helpers. Each managed agent runs in its own worktree so
 * parallel agents never fight over the same working tree.
 */

import * as os from "node:os";
import * as path from "node:path";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

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

/** Resolve the git repository root containing `cwd`, or throw. */
export async function repoRoot(cwd: string): Promise<string> {
	const r = await runGit(["rev-parse", "--show-toplevel"], cwd);
	if (r.code !== 0) throw new Error(`not a git repository: ${cwd}${r.stderr ? ` (${r.stderr})` : ""}`);
	return r.stdout;
}

/** Base directory for squad-managed worktrees. */
export function worktreeBase(): string {
	return path.join(os.homedir(), ".omp", "squad", "worktrees");
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
	const r = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
	return r.code === 0;
}

export interface CreatedWorktree {
	worktree: string;
	branch: string;
	repo: string;
}

/**
 * Create (or reuse) a worktree for `repo` checked out to `branch`.
 * If the branch exists it is checked out; otherwise it is created off HEAD.
 */
export async function addWorktree(opts: {
	repo: string;
	branch: string;
	dir?: string;
}): Promise<CreatedWorktree> {
	const repo = await repoRoot(opts.repo);
	const safe = opts.branch.replace(/[^a-zA-Z0-9._-]/g, "-");
	const dir = opts.dir ?? path.join(worktreeBase(), `${path.basename(repo)}-${safe}`);

	// Already registered as a worktree at this path? Reuse it.
	const list = await runGit(["worktree", "list", "--porcelain"], repo);
	if (list.code === 0 && list.stdout.includes(`worktree ${dir}\n`)) {
		return { worktree: dir, branch: opts.branch, repo };
	}

	const exists = await branchExists(repo, opts.branch);
	const args = exists
		? ["worktree", "add", dir, opts.branch]
		: ["worktree", "add", "-b", opts.branch, dir];
	const r = await runGit(args, repo);
	if (r.code !== 0) {
		throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`);
	}
	return { worktree: dir, branch: opts.branch, repo };
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
