/**
 * Landing — commit an agent's worktree and merge it back, so the whole
 * spawn → review → ship loop is one click in the web UI (no terminal, no git).
 *
 * Worktree agent: commit on its `squad/<name>` branch, then merge that branch
 * into the main checkout (fast-forward when possible, else a merge commit).
 * In-place agent (ran directly in a dir, no worktree branch): just commit there.
 */

export interface LandResult {
	ok: boolean;
	committed: boolean;
	merged: boolean;
	message: string;
	detail?: string;
}

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

async function git(args: string[], cwd: string): Promise<GitRun> {
	const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function landAgent(opts: { repo: string; worktree: string; branch?: string; message: string }): Promise<LandResult> {
	const { repo, worktree, branch, message } = opts;

	const status = await git(["status", "--porcelain"], worktree);
	const hasChanges = status.code === 0 && status.stdout.length > 0;

	let committed = false;
	if (hasChanges) {
		const add = await git(["add", "-A"], worktree);
		if (add.code !== 0) return { ok: false, committed: false, merged: false, message, detail: `git add failed: ${add.stderr}` };
		const commit = await git(["commit", "-m", message], worktree);
		if (commit.code !== 0) return { ok: false, committed: false, merged: false, message, detail: `git commit failed: ${commit.stderr || commit.stdout}` };
		committed = true;
	}

	// In-place agent (no separate branch / worktree === repo): nothing to merge.
	if (!branch || worktree === repo) {
		return {
			ok: true,
			committed,
			merged: false,
			message,
			detail: committed ? "committed in place (no branch to merge)" : "no changes to commit",
		};
	}

	// Nothing committed and the branch has no commits ahead → nothing to land.
	const ahead = await git(["rev-list", "--count", `HEAD..${branch}`], repo);
	if (!committed && ahead.code === 0 && ahead.stdout === "0") {
		return { ok: true, committed: false, merged: false, message, detail: "no changes to land" };
	}

	const ff = await git(["merge", "--ff-only", branch], repo);
	if (ff.code === 0) return { ok: true, committed, merged: true, message, detail: `merged ${branch} (fast-forward)` };

	// Diverged → real merge commit.
	const merge = await git(["merge", "--no-ff", "-m", `Merge ${branch}: ${message}`, branch], repo);
	if (merge.code === 0) return { ok: true, committed, merged: true, message, detail: `merged ${branch}` };

	await git(["merge", "--abort"], repo).catch(() => undefined);
	return { ok: false, committed, merged: false, message, detail: `merge failed: ${merge.stderr || merge.stdout}` };
}
