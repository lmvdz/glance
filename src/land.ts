/**
 * Landing — commit an agent's worktree and merge it back, so the whole
 * spawn → review → ship loop is one click in the web UI (no terminal, no git).
 *
 * Worktree agent: commit on its `squad/<name>` branch, then merge that branch
 * into the main checkout (fast-forward when possible, else a merge commit).
 * In-place agent (ran directly in a dir, no worktree branch): just commit there.
 */

import { detectVerify } from "./intake.ts";

export interface LandResult {
	ok: boolean;
	committed: boolean;
	merged: boolean;
	message: string;
	detail?: string;
}

/** Inputs to land one agent's worktree. */
export interface LandOpts {
	repo: string;
	worktree: string;
	branch?: string;
	message: string;
	commitWip: boolean;
	/**
	 * Verification command run against main AFTER the merge; the merge is rolled back
	 * if it exits non-zero. undefined ⇒ auto-detect via detectVerify(repo); empty string
	 * ⇒ skip verification.
	 */
	verify?: string;
}

/**
 * Per-repo land serialization. Two lands racing the same main checkout interleave
 * `git merge` and corrupt the index; chaining them also makes each land re-read
 * HEAD when it runs, so it sees the commits prior lands just merged.
 * ponytail: in-process map — one squad daemon owns a checkout. Add a file lock if
 * lands ever race across processes/hosts.
 */
const repoLands = new Map<string, Promise<unknown>>();

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

/** Run a verification command, killing it after `timeoutMs`. Returns exit code + combined output. */
async function runGate(cmd: string, cwd: string, timeoutMs = 600_000): Promise<{ code: number; output: string }> {
	const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, output: `${stdout}${stderr}`.trim() };
	} finally {
		clearTimeout(timer);
	}
}

/** Cap a string to `n` chars so a gate's failure dump doesn't bloat the land detail. */
function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export function landAgent(opts: LandOpts): Promise<LandResult> {
	const prev = repoLands.get(opts.repo) ?? Promise.resolve();
	const run = prev.catch(() => {}).then(() => landAgentLocked(opts));
	repoLands.set(opts.repo, run.catch(() => {}));
	return run;
}

async function landAgentLocked(opts: LandOpts): Promise<LandResult> {
	const { repo, worktree, branch, message, commitWip } = opts;

	// Only sweep the worktree's uncommitted edits into a commit when the caller says it's safe
	// (agent idle/stopped). For a LIVE agent (working/starting/input) commitWip is false: we merge
	// only its committed history and never touch its in-progress edits.
	let committed = false;
	if (commitWip) {
		const status = await git(["status", "--porcelain"], worktree);
		if (status.code === 0 && status.stdout.length > 0) {
			const add = await git(["add", "-A"], worktree);
			if (add.code !== 0) return { ok: false, committed: false, merged: false, message, detail: `git add failed: ${add.stderr}` };
			const commit = await git(["commit", "-m", message], worktree);
			if (commit.code !== 0) return { ok: false, committed: false, merged: false, message, detail: `git commit failed: ${commit.stderr || commit.stdout}` };
			committed = true;
		}
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
		return { ok: true, committed: false, merged: false, message, detail: commitWip ? "no changes to land" : "no committed changes to land (agent still working — uncommitted edits left untouched)" };
	}

	// Capture pre-merge main HEAD so a failed verification can roll main back, and resolve the
	// gate to run after merge (caller override wins; undefined ⇒ auto-detect; empty ⇒ skip).
	const head0 = (await git(["rev-parse", "HEAD"], repo)).stdout;
	const gate = opts.verify !== undefined ? opts.verify : await detectVerify(repo);

	// Verify the merged main; if the gate fails, reset main to head0 so it stays green. The
	// worktree branch keeps its commit (only main is reset), so it can be re-landed after a fix.
	const verifyMerged = async (detail: string): Promise<LandResult> => {
		if (!gate) return { ok: true, committed, merged: true, message, detail };
		const v = await runGate(gate, repo);
		if (v.code === 0) return { ok: true, committed, merged: true, message, detail: `${detail}; verified (${gate})` };
		await git(["reset", "--hard", head0], repo).catch(() => {});
		return {
			ok: false,
			committed,
			merged: false,
			message,
			detail: `merged ${branch} but verification failed (${gate}) — rolled main back to keep it green:\n${truncate(v.output, 800)}`,
		};
	};

	const ff = await git(["merge", "--ff-only", branch], repo);
	if (ff.code === 0) return verifyMerged(`merged ${branch} (fast-forward)`);

	// Diverged → real merge commit.
	const merge = await git(["merge", "--no-ff", "-m", `Merge ${branch}: ${message}`, branch], repo);
	if (merge.code === 0) return verifyMerged(`merged ${branch}`);

	await git(["merge", "--abort"], repo).catch(() => undefined);
	return { ok: false, committed, merged: false, message, detail: `merge failed: ${merge.stderr || merge.stdout}` };
}
