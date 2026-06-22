/**
 * Landing — commit an agent's worktree and merge it back, so the whole
 * spawn → review → ship loop is one click in the web UI (no terminal, no git).
 *
 * Worktree agent: commit on its `squad/<name>` branch, then merge that branch
 * into the main checkout (fast-forward when possible, else a merge commit).
 * In-place agent (ran directly in a dir, no worktree branch): just commit there.
 *
 * On a conflicting merge it aborts and gives up — unless OMP_SQUAD_AUTORESOLVE is set, when it
 * tries automated resolution (#12): rebase → resolver → verify gate → reviewer, kept only if proven.
 */

import { detectVerify } from "./intake.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

export interface LandResult {
	ok: boolean;
	committed: boolean;
	merged: boolean;
	message: string;
	detail?: string;
}

/**
 * Resolve the conflicted files in a rebasing worktree (#12). Returns true once it has left the
 * files edited (the caller stages + continues the rebase); the verify gate + reviewer below are
 * what actually prove the result. Injectable so tests need no real omp.
 */
export type ConflictResolver = (input: { worktree: string; files: string[]; branch: string; target: string }) => Promise<boolean>;

/** Independent second opinion on an auto-resolved land (#12). Returns true to approve. Injectable. */
export type ResolutionReviewer = (input: { repo: string; worktree: string; branch: string }) => Promise<boolean>;

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
	/** Conflict-resolver override (#12). undefined ⇒ default one-shot `omp -p` agent. */
	resolver?: ConflictResolver;
	/** Resolution reviewer override (#12). undefined ⇒ default one-shot `omp -p` reviewer. */
	reviewer?: ResolutionReviewer;
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
	// ponytail: untrusted repo config can exec code via core.fsmonitor/diff.external/hooks/pager — these neutralize it.
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "pipe" });
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

	// Conflict — abort to leave main clean at head0, then try automated resolution (#12) if armed.
	await git(["merge", "--abort"], repo).catch(() => undefined);

	// Opt-in via OMP_SQUAD_AUTORESOLVE, and only when the worktree is clean: a live agent's
	// uncommitted edits are never clobbered by the rebase. Off/dirty ⇒ give up exactly as before.
	const wtClean = (await git(["status", "--porcelain"], worktree)).stdout.length === 0;
	if (autoresolve() && wtClean) {
		return attemptAutoResolve({
			repo, worktree, branch, head0, gate, message, committed,
			resolver: opts.resolver ?? defaultResolver(),
			reviewer: opts.reviewer ?? defaultReviewer(),
		});
	}
	return { ok: false, committed, merged: false, message, detail: `merge failed: ${merge.stderr || merge.stdout}` };
}

/** On by default; set OMP_SQUAD_AUTORESOLVE=0 to disable automated conflict resolution during a land. */
function autoresolve(): boolean {
	return process.env.OMP_SQUAD_AUTORESOLVE !== "0";
}

/** Bound the rebase resolve loop so a pathological branch can't spin forever. */
const REBASE_STEP_CAP = 100;
/** Wall-clock cap on a single default omp resolver/reviewer pass. */
const RESOLVE_TIMEOUT_MS = 600_000;

/**
 * Automated conflict resolution (#12): rebase `branch` onto main (head0), hand each conflicted step
 * to the resolver, then PROVE the result — the full verify gate must pass AND an independent reviewer
 * must approve — before completing the land. Any failure rolls main back to head0 and returns ok:false.
 * An unproven resolution is never kept.
 *
 * ponytail: semantic-merge ceiling. The verify gate + reviewer can both pass on a merge that is
 * textually clean and compiles but is semantically wrong (two sides edited disjoint code that
 * interacts at runtime); a test suite misses what it doesn't assert. Upgrade path: gate auto-landed
 * resolutions behind a human ack or a property/integration suite in high-stakes repos.
 */
async function attemptAutoResolve(a: {
	repo: string; worktree: string; branch: string; head0: string; gate: string | undefined; message: string; committed: boolean;
	resolver: ConflictResolver; reviewer: ResolutionReviewer;
}): Promise<LandResult> {
	const { repo, worktree, branch, head0, gate, message, committed, resolver, reviewer } = a;
	const fail = (detail: string): LandResult => ({ ok: false, committed, merged: false, message, detail });

	// (a) Rebase the branch onto main; (b) the resolver clears each conflicted step.
	let r = await git(["rebase", head0], worktree);
	for (let step = 0; r.code !== 0 && step < REBASE_STEP_CAP; step++) {
		const files = (await git(["diff", "--name-only", "--diff-filter=U"], worktree)).stdout
			.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
		if (files.length === 0) break; // stopped for a non-conflict reason → bail out below
		const resolved = await resolver({ worktree, files, branch, target: head0 }).catch(() => false);
		if (!resolved) {
			await git(["rebase", "--abort"], worktree).catch(() => undefined);
			return fail(`auto-resolve: resolver gave up on ${branch} (${files.join(", ")})`);
		}
		await git(["add", "-A"], worktree);
		// core.editor=true ⇒ `rebase --continue` reuses the commit message instead of opening an editor.
		r = await git(["-c", "core.editor=true", "rebase", "--continue"], worktree);
	}
	if (r.code !== 0) {
		await git(["rebase", "--abort"], worktree).catch(() => undefined);
		return fail(`auto-resolve: rebase of ${branch} failed: ${r.stderr || r.stdout}`);
	}

	// Rebased clean ⇒ the branch now fast-forwards into main.
	const ff = await git(["merge", "--ff-only", branch], repo);
	if (ff.code !== 0) return fail(`auto-resolve: rebased ${branch} but fast-forward failed: ${ff.stderr || ff.stdout}`);

	const rollback = async (why: string): Promise<LandResult> => {
		await git(["reset", "--hard", head0], repo).catch(() => undefined);
		return fail(why);
	};

	// (c) The resolution is unproven until the FULL gate passes on the merged main.
	if (gate) {
		const v = await runGate(gate, repo);
		if (v.code !== 0) return rollback(`auto-resolved ${branch} but verification failed (${gate}) — rolled main back:\n${truncate(v.output, 800)}`);
	}

	// (d) Independent second opinion before keeping an LLM-merged result.
	const approved = await reviewer({ repo, worktree, branch }).catch(() => false);
	if (!approved) return rollback(`auto-resolved ${branch} but reviewer rejected the resolution — rolled main back`);

	// (e) Proven ⇒ keep it.
	return { ok: true, committed, merged: true, message, detail: `auto-resolved conflict and merged ${branch}${gate ? `; verified (${gate})` : ""}; reviewer approved` };
}

/**
 * Default resolver: a one-shot `omp -p` agent pointed at the conflicted worktree, told to clear the
 * conflict markers. Returns true only if omp exits 0 — the verify gate + reviewer prove the result,
 * so a bad edit here is caught downstream, never shipped.
 */
function defaultResolver(): ConflictResolver {
	return async ({ worktree, files }) => {
		const prompt = `You are resolving git rebase conflicts in this repository. These files contain conflict markers (<<<<<<<, =======, >>>>>>>): ${files.join(", ")}. Edit each file into a correct, compiling resolution that preserves the intent of BOTH sides and removes every conflict marker. Do not run git or commit — just leave the files resolved.`;
		const proc = Bun.spawn(["omp", "-p", "--approval-mode", "yolo", prompt], { cwd: worktree, stdout: "ignore", stderr: "ignore", env: { ...process.env }, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
		return (await proc.exited.catch(() => 1)) === 0;
	};
}

/**
 * Default reviewer: a one-shot `omp -p` agent that inspects the merged HEAD and must answer APPROVE.
 * See the semantic-merge ceiling on attemptAutoResolve — this is a best-effort LLM second opinion.
 */
function defaultReviewer(): ResolutionReviewer {
	return async ({ repo, branch }) => {
		const prompt = `An automated tool just rebased and merged branch "${branch}" into main in this repository. Inspect the result (e.g. \`git show HEAD\`, \`git diff HEAD~1\`) for semantic conflicts a test suite might not catch. Reply with exactly the single word APPROVE if the merge is correct, otherwise reply REJECT.`;
		const proc = Bun.spawn(["omp", "-p", "--approval-mode", "yolo", prompt], { cwd: repo, stdout: "pipe", stderr: "ignore", env: { ...process.env }, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
		const out = (await new Response(proc.stdout).text()).toUpperCase();
		await proc.exited.catch(() => undefined);
		return /\bAPPROVE\b/.test(out) && !/\bREJECT\b/.test(out);
	};
}
