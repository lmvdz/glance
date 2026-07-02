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
import { gateEnv } from "./gate-env.ts";
import { proofGate } from "./proof.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV, gitNoSignEnv } from "./git-harden.ts";

export interface LandResult {
	ok: boolean;
	committed: boolean;
	merged: boolean;
	message: string;
	detail?: string;
	/**
	 * Auto-resolve confirm hold (OMPSQ-138): the conflict was auto-resolved on the branch but the
	 * merge was NOT kept — it is staged for a one-tap Land. `ok` stays false (nothing merged) but the
	 * caller must treat this as "staged", not "blocked": no merge-retry, no park (OMPSQ-175).
	 */
	staged?: boolean;
	/**
	 * Environmental precondition blocked the land — the main checkout had uncommitted TRACKED changes,
	 * not a branch defect. `ok` stays false (nothing merged) but the caller must RETRY later WITHOUT
	 * bumping the fail streak or parking/halting the branch: a transient dirty main (a human editing the
	 * shared checkout) would otherwise permanently brick every healthy branch behind it.
	 */
	retryable?: boolean;
}

/**
 * Boot-time warnings for land targets that carry uncommitted TRACKED changes. The land path refuses to
 * merge into a dirty main (a failed-gate rollback would `git reset --hard` and discard them), so
 * auto-lands DEFER (retryable) until it's clean. A target that STAYS dirty means the daemon is sharing
 * its checkout with a human editor — the durable fix is a DEDICATED checkout no one hand-edits. Pure +
 * injectable (`dirtyCount` reads git) so it's testable without a real repo.
 */
export function dirtyLandTargetWarnings(repos: string[], dirtyCount: (repo: string) => number): string[] {
	const warnings: string[] = [];
	for (const repo of repos) {
		const n = dirtyCount(repo);
		if (n > 0) {
			warnings.push(
				`land target ${repo} has ${n} uncommitted tracked file(s) — auto-lands will DEFER until it is clean. ` +
					`Run the daemon against a DEDICATED checkout that no human edits (README → "Dedicated land checkout").`,
			);
		}
	}
	return warnings;
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
	/** Require a fresh pre-merge land proof before any non-forced branch merge. */
	requireProof?: boolean;
	/** Conflict-resolver override (#12). undefined ⇒ default one-shot `omp -p` agent. */
	resolver?: ConflictResolver;
	/** Resolution reviewer override (#12). undefined ⇒ default one-shot `omp -p` reviewer. */
	reviewer?: ResolutionReviewer;
	/**
	 * Auto-resolve confirm hold (OMPSQ-138, OMP_SQUAD_AUTORESOLVE_CONFIRM): when true, a conflicting
	 * land is auto-resolved on the branch (rebased onto main) but NOT merged — it returns
	 * `{ ok:false, staged:true }` so a human one-tap Land keeps the resolved merge. A clean
	 * (non-conflicting) land still merges. Off (operator land) ⇒ resolve + merge as before.
	 */
	confirmResolved?: boolean;
}

/**
 * Per-repo serialization of every operation that mutates OR reads the shared main checkout.
 * Two lands racing the same checkout interleave `git merge` and corrupt the index; chaining them
 * also makes each land re-read HEAD when it runs, so it sees the commits prior lands just merged.
 * The Observer's acceptance gate (`bun test` on main) reads that same tree, so it joins this queue
 * too — otherwise it can `(fail)` transiently against a half-merged / mid-rollback main and file a
 * false `regression:` bug (OMPSQ-168).
 * ponytail: in-process map — one squad daemon owns a checkout. Add a file lock if work ever races
 * across processes/hosts.
 */
const repoLands = new Map<string, Promise<unknown>>();

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

async function git(args: string[], cwd: string): Promise<GitRun> {
	// ponytail: untrusted repo config can exec code via core.fsmonitor/diff.external/hooks/pager — GIT_HARDEN_ARGS neutralizes it AND forces commit/tag signing off.
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Run a verification command, killing it after `timeoutMs`. Returns exit code + combined output. */
async function runGate(cmd: string, cwd: string, timeoutMs = 600_000): Promise<{ code: number; output: string }> {
	// gateEnv: the verify command runs agent-authored tests — scrub the daemon's secrets.
	const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: gateEnv() });
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

const FAILURE_DURATION_SUFFIX = /\s*\[[\d.]+\s*(?:ns|[µu]s|ms|s)\]$/;

function normalizeFailureIdentity(failure: string): string {
	return failure.replace(FAILURE_DURATION_SUFFIX, "").trim();
}

function uniqueSortedFailures(failures: Iterable<string>): string[] {
	return [...new Set([...failures].map(normalizeFailureIdentity).filter((f) => f.length > 0))].sort();
}

export function extractGateFailures(output: string, fallback = "gate"): string[] {
	const parsed = uniqueSortedFailures(output.split("\n").flatMap((line) => {
		const match = line.match(/\(fail\)\s*(.+)$/);
		return match ? [match[1] ?? ""] : [];
	}));
	if (parsed.length > 0) return parsed;
	const firstLine = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
	return uniqueSortedFailures([firstLine ?? fallback]);
}

export function decideRegressionGate(baseFailures: Iterable<string>, mergedFailures: Iterable<string>): { allow: boolean; newRegressions: string[] } {
	const base = new Set(uniqueSortedFailures(baseFailures));
	const newRegressions = uniqueSortedFailures(mergedFailures).filter((failure) => !base.has(failure));
	return { allow: newRegressions.length === 0, newRegressions };
}

/** On by default when OMP_SQUAD_REGRESSION_GATE=1. */
function regressionGateEnabled(): boolean {
	return process.env.OMP_SQUAD_REGRESSION_GATE === "1";
}

/**
 * Post-merge full-suite regression gate (OMP_SQUAD_REGRESSION_GATE=1).
 *
 * Called after the acceptance gate passes, with main already at the merged state. Runs the full
 * suite via detectVerify() — deliberately separate from opts.verify, which can be narrower.
 * Returns null to allow the land, or a blocking LandResult to reject it. Leaves main at the
 * correct state: merged HEAD (allow) or head0 (block). Red-baseline handling: if the full suite
 * also fails on base, decideRegressionGate() compares the extracted failure sets — only strictly
 * new failures block; pre-existing red baseline failures allow a re-merge.
 */
async function applyRegressionGate(p: {
	repo: string;
	head0: string;
	committed: boolean;
	message: string;
	branch: string;
	reMerge: () => Promise<GitRun>;
}): Promise<LandResult | null> {
	if (!regressionGateEnabled()) return null;
	const fullSuite = await detectVerify(p.repo);
	if (!fullSuite) return null;

	const mergedRun = await runGate(fullSuite, p.repo);
	if (mergedRun.code === 0) return null; // full suite clean on merged main

	// Full suite failed on merged main — determine whether branch introduced new failures.
	await git(["reset", "--hard", p.head0], p.repo).catch(() => {});
	const baseRun = await runGate(fullSuite, p.repo);
	const baseFailures = baseRun.code !== 0 ? extractGateFailures(baseRun.output) : [];
	const mergedFailures = extractGateFailures(mergedRun.output);
	const { allow, newRegressions } = decideRegressionGate(baseFailures, mergedFailures);

	if (!allow) {
		// New failures introduced — keep main reset to head0, block the land.
		return {
			ok: false,
			committed: p.committed,
			merged: false,
			message: p.message,
			detail: `regression gate (${fullSuite}) blocked ${p.branch}: ${newRegressions.length} new failure(s):\n  ${newRegressions.join("\n  ")}\n${truncate(mergedRun.output, 600)}`,
		};
	}

	// No new regressions — base already had these failures. Re-merge so main advances.
	const rm = await p.reMerge();
	if (rm.code !== 0) {
		return {
			ok: false,
			committed: p.committed,
			merged: false,
			message: p.message,
			detail: `regression gate: no new regressions in ${p.branch} but re-merge failed: ${rm.stderr || rm.stdout}`,
		};
	}
	return null; // allowed — pre-existing red baseline, no new failures introduced
}

/**
 * Run `fn` serialized against this repo's lands (and any other work already queued on the same
 * checkout). Use it for anything that reads or writes the shared main tree concurrently with lands —
 * e.g. the Observer's acceptance gate — so it never observes a half-merged / mid-rollback main.
 */
export function withRepoLandLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
	const prev = repoLands.get(repo) ?? Promise.resolve();
	const run = prev.catch(() => {}).then(fn);
	repoLands.set(repo, run.catch(() => {}));
	return run;
}

export function landAgent(opts: LandOpts): Promise<LandResult> {
	return withRepoLandLock(opts.repo, () => landAgentLocked(opts));
}

async function landAgentLocked(opts: LandOpts): Promise<LandResult> {
	const { repo, worktree, branch, message, commitWip } = opts;

	// Only sweep the worktree's uncommitted edits into a commit when the caller says it's safe
	// (agent idle/stopped). For a LIVE agent (working/starting/input) commitWip is false: we merge
	// only its committed history and never touch its in-progress edits.
	// `.omp/` is excluded from the sweep on both sides: it's the daemon's own evidence dir
	// (vision screenshots, proof artifacts) — sweeping it committed screenshots into main AND,
	// because the proof fingerprint also ignores `.omp/`, would land content the gate never saw.
	let committed = false;
	if (commitWip) {
		const status = await git(["status", "--porcelain", "--", ".", ":(exclude).omp"], worktree);
		if (status.code === 0 && status.stdout.length > 0) {
			const add = await git(["add", "-A", "--", ".", ":(exclude).omp"], worktree);
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

	if (opts.requireProof) {
		const reason = await proofGate(repo, worktree, branch, opts.verify);
		if (reason) return { ok: false, committed, merged: false, message, detail: reason };
	}

	// Nothing committed and the branch has no commits ahead → nothing to land.
	const ahead = await git(["rev-list", "--count", `HEAD..${branch}`], repo);
	if (!committed && ahead.code === 0 && ahead.stdout === "0") {
		return { ok: true, committed: false, merged: false, message, detail: commitWip ? "no changes to land" : "no committed changes to land (agent still working — uncommitted edits left untouched)" };
	}

	// Refuse to merge into a main checkout that has TRACKED uncommitted changes: the rollback path
	// below (git reset --hard head0) would destroy them. Untracked files (-uno) are excluded — a
	// hard reset never removes them, so they don't block a land. A clean main checkout is the land's
	// blast-radius contract. ponytail: in-place agents (worktree===repo) returned above; upgrade
	// path: stash + restore around the land instead of refusing.
	const mainStatus = await git(["status", "--porcelain", "--untracked-files=no"], repo);
	if (mainStatus.code === 0 && mainStatus.stdout.length > 0) {
		return { ok: false, retryable: true, committed, merged: false, message, detail: `main checkout ${repo} has uncommitted tracked changes — refusing to land ${branch} (a failed-gate rollback would discard them); commit or stash them first` };
	}

	// Capture pre-merge main HEAD so a failed verification can roll main back, and resolve the
	// gate to run after merge (caller override wins; undefined ⇒ auto-detect; empty ⇒ skip).
	const head0 = (await git(["rev-parse", "HEAD"], repo)).stdout;
	const gate = opts.verify !== undefined ? opts.verify : await detectVerify(repo);

	// Verify the merged main; if the gate fails, reset main to head0 so it stays green. The
	// worktree branch keeps its commit (only main is reset), so it can be re-landed after a fix.
	const verifyMerged = async (detail: string, reMerge: () => Promise<GitRun>): Promise<LandResult> => {
		if (!gate) {
			// No acceptance gate — still run the full-suite regression gate if armed.
			const rg = await applyRegressionGate({ repo, head0, committed, message, branch: branch ?? "", reMerge });
			if (rg) return rg;
			return { ok: true, committed, merged: true, message, detail };
		}
		const v = await runGate(gate, repo);
		if (v.code === 0) {
			// Acceptance gate green — additionally run the full-suite regression gate if armed.
			const rg = await applyRegressionGate({ repo, head0, committed, message, branch: branch ?? "", reMerge });
			if (rg) return rg;
			return { ok: true, committed, merged: true, message, detail: `${detail}; verified (${gate})` };
		}
		// Merged gate failed — distinguish "branch regressed a green base" from "base was already red".
		await git(["reset", "--hard", head0], repo).catch(() => {});
		const base = await runGate(gate, repo); // main == head0 now
		if (base.code === 0) {
			// Base was green ⇒ the branch introduced the failure ⇒ keep main green, block (unchanged).
			return {
				ok: false,
				committed,
				merged: false,
				message,
				detail: `merged ${branch} but verification failed (${gate}) — rolled main back to keep it green:\n${truncate(v.output, 800)}`,
			};
		}
		// Base was already red ⇒ main was never green; refusing would wedge every land on a brownfield
		// repo. Re-apply the merge and land, recording that we landed onto a red baseline.
		// ponytail: binary gate can't tell "still red" from "redder" — a branch that worsens an already
		// red base still lands. Upgrade path: per-framework failing-test diffing if that ever bites.
		const rm = await reMerge();
		if (rm.code !== 0) {
			return { ok: false, committed, merged: false, message, detail: `base already red (${gate}); re-merging ${branch} failed: ${rm.stderr || rm.stdout}` };
		}
		return { ok: true, committed, merged: true, message, detail: `${detail}; landed onto a red baseline — main was not green at head0 (${gate})` };
	};

	const ff = await git(["merge", "--ff-only", branch], repo);
	if (ff.code === 0) return verifyMerged(`merged ${branch} (fast-forward)`, () => git(["merge", "--ff-only", branch], repo));

	// Diverged → real merge commit.
	const merge = await git(["merge", "--no-ff", "-m", `Merge ${branch}: ${message}`, branch], repo);
	if (merge.code === 0) return verifyMerged(`merged ${branch}`, () => git(["merge", "--no-ff", "-m", `Merge ${branch}: ${message}`, branch], repo));

	// Conflict — abort to leave main clean at head0, then try automated resolution (#12) if armed.
	await git(["merge", "--abort"], repo).catch(() => undefined);

	// Opt-in via OMP_SQUAD_AUTORESOLVE, and only when the worktree is clean: a live agent's
	// uncommitted edits are never clobbered by the rebase. Off/dirty ⇒ give up exactly as before.
	const wtClean = (await git(["status", "--porcelain"], worktree)).stdout.length === 0;
	if (autoresolve() && wtClean) {
		return attemptAutoResolve({
			repo, worktree, branch, head0, gate, message, committed,
			confirmResolved: opts.confirmResolved ?? false,
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
 *
 * confirmResolved (OMPSQ-138): when set, stop after a successful rebase+resolve and return
 * { ok:false, staged:true } WITHOUT merging — a human one-tap Land keeps the resolved merge.
 */
async function attemptAutoResolve(a: {
	repo: string; worktree: string; branch: string; head0: string; gate: string | undefined; message: string; committed: boolean;
	confirmResolved: boolean;
	resolver: ConflictResolver; reviewer: ResolutionReviewer;
}): Promise<LandResult> {
	const { repo, worktree, branch, head0, gate, message, committed, confirmResolved, resolver, reviewer } = a;
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

	// Confirm hold (OMPSQ-138): the conflict is resolved on the rebased branch, but the merge is held
	// for a human one-tap Land. Main is untouched (the original merge was aborted), so nothing reaches
	// it without an operator. The operator's land (confirmResolved:false) fast-forwards the already-
	// rebased branch — no second resolve — and runs the gate then. ponytail: if main advances before
	// the operator confirms, that ff fails and the branch re-resolves on the next land; acceptable.
	if (confirmResolved) {
		return { ok: false, staged: true, committed, merged: false, message, detail: `auto-resolved conflict on ${branch} — staged for one-tap Land (OMP_SQUAD_AUTORESOLVE_CONFIRM)` };
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

	// (c2) Full-suite regression gate — auto-resolved lands must not bypass it.
	const rgr = await applyRegressionGate({ repo, head0, committed, message, branch, reMerge: () => git(["merge", "--ff-only", branch], repo) });
	if (rgr) return rgr;

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
		const proc = Bun.spawn(["omp", "-p", "--approval-mode", "yolo", prompt], { cwd: worktree, stdout: "ignore", stderr: "ignore", env: { ...process.env, ...gitNoSignEnv() }, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
		return (await proc.exited.catch(() => 1)) === 0;
	};
}

/** True iff the model's free-text review approves: contains APPROVE and NOT REJECT (case-insensitive). */
export function parseApproval(raw: string): boolean {
	const out = raw.toUpperCase();
	return /\bAPPROVE\b/.test(out) && !/\bREJECT\b/.test(out);
}

/**
 * Default reviewer: a one-shot `omp -p` agent that inspects the merged HEAD and must answer APPROVE.
 * See the semantic-merge ceiling on attemptAutoResolve — this is a best-effort LLM second opinion.
 */
function defaultReviewer(): ResolutionReviewer {
	return async ({ repo, branch }) => {
		const prompt = `An automated tool just rebased and merged branch "${branch}" into main in this repository. Inspect the result (e.g. \`git show HEAD\`, \`git diff HEAD~1\`) for semantic conflicts a test suite might not catch. Reply with exactly the single word APPROVE if the merge is correct, otherwise reply REJECT.`;
		const proc = Bun.spawn(["omp", "-p", "--approval-mode", "yolo", prompt], { cwd: repo, stdout: "pipe", stderr: "ignore", env: { ...process.env, ...gitNoSignEnv() }, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
		const text = await new Response(proc.stdout).text();
		await proc.exited.catch(() => undefined);
		return parseApproval(text);
	};
}
