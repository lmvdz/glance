/**
 * Worktree reaper — frees disk + git admin entries for squad worktrees whose
 * agent is gone and whose work is safely accounted for, so repeated re-dispatch
 * stops leaving one orphan worktree per attempt forever.
 *
 * A worktree is reaped only when ALL of these hold (OMPSQ-41 — never destroy in-flight work):
 *   - under base:   it lives under the daemon's managed worktree base (worktreeBase()); an out-of-band
 *                   worktree (e.g. a hand-made one, even under /tmp) is never touched, AND
 *   - unowned:      no live roster agent owns it, AND
 *   - clean:        no uncommitted changes (a dirty worktree is live in-progress work — even with zero
 *                   commits, an agent mid-task before its first commit — and is NEVER reaped), AND
 *   - past grace:   older than `graceMs` (a freshly-created / mid-spawn worktree is left alone), AND
 *   - dead:         either "merged" (every commit on its branch is already in base) OR "issue-closed"
 *                   (its tracking Plane issue is no longer open).
 *
 * Lossless by construction: a branch is deleted only when it is fully merged (0 unmerged commits — git's
 * own `branch -d` is the final backstop). An issue-closed branch that still carries unmerged commits keeps
 * its branch; only its worktree admin entry is pruned. So nothing recoverable is destroyed.
 *
 * Pure: every I/O edge (git ahead-count, dirty state, mtime, Plane open set) is
 * resolved into `WorktreeInfo`/`ReapInput` by the caller, so the policy is tested
 * without git, Plane, the clock, or the filesystem.
 */

import * as path from "node:path";

export interface WorktreeInfo {
	/** Absolute worktree path. */
	worktree: string;
	/** Local branch checked out there, e.g. "squad/ompsq-35-…". Empty ⇒ detached. */
	branch: string;
	/** Commits on `branch` not reachable from the base branch (0 ⇒ merged/empty; <0 ⇒ unknown — the
	 *  git read failed, land-mode.ts's `aheadOfBase` -1 sentinel, `aheadUnknown` there). Deliberately
	 *  left as `number`, not `number | "unknown"`, because `selectReapable` below only ever tests it
	 *  with EXACT equality (`=== 0`) — any nonzero value, unknown included, already falls into
	 *  "not merged" without a separate branch, so a union type would buy nothing here and would force
	 *  every test in this file's suite to stop passing plain numbers. */
	aheadOfBase: number;
	/** Worktree dir mtime (ms) — recency guard against reaping a mid-spawn worktree. */
	mtimeMs: number;
	/** Has uncommitted changes. */
	dirty: boolean;
	/** The repo's primary worktree (the main checkout) — never reaped. */
	isPrimary: boolean;
	/** A recorded DoneProof exists for this branch — treated as equivalent to `aheadOfBase === 0`
	 *  (provably landed) regardless of what the arithmetic reports. Squash/rebase merges make
	 *  `aheadOfBase` permanently nonzero even once the work is safely in origin/default, so without
	 *  this a proven-landed branch's worktree would never be reaped via the "merged" reason. */
	proven?: boolean;
}

export interface ReapInput {
	worktrees: WorktreeInfo[];
	/** The daemon's managed worktree base (worktreeBase()). A worktree outside it is never reaped. */
	managedBase: string;
	/** Worktree paths owned by a live roster agent — never reaped. */
	owned: Set<string>;
	/** Open Plane issue identifiers (UPPERCASE). `null` ⇒ Plane unreachable ⇒ skip the issue-closed test. */
	openIdentifiers: Set<string> | null;
	now: number;
	graceMs: number;
}

export type ReapReason = "merged" | "issue-closed";

export interface ReapDecision {
	worktree: string;
	branch: string;
	reason: ReapReason;
	/** Delete the branch too — only when fully merged + clean, i.e. provably lossless. */
	deleteBranch: boolean;
}

/** Plane identifier embedded in a squad branch: "squad/ompsq-35-<suffix>" → "OMPSQ-35". `undefined` if none.
 *  @substrate exported for tests only — worktree-reaper.test.ts pins the branch→identifier grammar directly. */
export function parseIssueIdentifier(branch: string): string | undefined {
	const m = /^squad\/([a-z][a-z0-9]*-\d+)-/i.exec(branch);
	return m ? m[1].toUpperCase() : undefined;
}

/** True when `worktree` is under `base` (path-prefix safe). Out-of-band worktrees fall outside (OMPSQ-41). */
function underBase(worktree: string, base: string): boolean {
	const rel = path.relative(base, worktree);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Decide which unowned, dead worktrees to reap. See module header for the safety contract. */
export function selectReapable(input: ReapInput): ReapDecision[] {
	const out: ReapDecision[] = [];
	for (const w of input.worktrees) {
		if (w.isPrimary || !w.branch) continue; // never the main checkout; skip detached (no branch to anchor)
		if (!underBase(w.worktree, input.managedBase)) continue; // OMPSQ-41: out-of-band worktree — never reap
		if (input.owned.has(w.worktree)) continue; // a live agent owns it
		if (w.dirty) continue; // OMPSQ-41: uncommitted work — never reap, even once its issue closes
		if (input.now - w.mtimeMs < input.graceMs) continue; // mid-spawn / recently active — leave it
		// Clean + past grace. "merged" = every commit already in base (aheadOfBase EXACTLY 0) OR a
		// recorded DoneProof (proven landed despite a nonzero/unknown count — squash/rebase merges);
		// <0 (unknown — the ahead-count git read failed) with no proof is deliberately NOT merged: the
		// exact-equality test below already fails closed for it, same as any other nonzero value.
		const merged = w.aheadOfBase === 0 || w.proven === true;
		const ident = parseIssueIdentifier(w.branch);
		const issueClosed = input.openIdentifiers !== null && ident !== undefined && !input.openIdentifiers.has(ident);
		if (!merged && !issueClosed) continue; // has unique work and issue still open ⇒ keep
		out.push({
			worktree: w.worktree,
			branch: w.branch,
			reason: merged ? "merged" : "issue-closed",
			// Only a merged branch (0 unmerged commits) is provably lossless to delete; an issue-closed
			// branch may still carry unmerged commits ⇒ keep it (branch -d is the final backstop).
			deleteBranch: merged,
		});
	}
	return out;
}
