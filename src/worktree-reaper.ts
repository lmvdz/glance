/**
 * Worktree reaper — frees disk + git admin entries for squad worktrees whose
 * agent is gone and whose work is safely accounted for, so repeated re-dispatch
 * stops leaving one orphan worktree per attempt forever.
 *
 * A worktree is reaped only when it is BOTH unowned (no live roster agent) AND
 * "dead" by one of:
 *   - merged:        every commit on its branch is already in the base (main), OR
 *   - issue-closed:  its tracking Plane issue is no longer open.
 *
 * Lossless by construction: abandoned uncommitted work is committed to the branch
 * first, and a branch is deleted only when it is fully merged + clean (git's own
 * `branch -d` is the final backstop), so nothing recoverable is destroyed. A
 * freshly-created worktree — still within `graceMs` of its mtime, or briefly
 * unowned mid-spawn (create() makes the worktree before the roster entry) — is
 * never touched.
 *
 * Pure: every I/O edge (git ahead-count, dirty state, mtime, Plane open set) is
 * resolved into `WorktreeInfo`/`ReapInput` by the caller, so the policy is tested
 * without git, Plane, the clock, or the filesystem.
 */

export interface WorktreeInfo {
	/** Absolute worktree path. */
	worktree: string;
	/** Local branch checked out there, e.g. "squad/ompsq-35-…". Empty ⇒ detached. */
	branch: string;
	/** Commits on `branch` not reachable from the base branch (0 ⇒ merged/empty; <0 ⇒ unknown). */
	aheadOfBase: number;
	/** Worktree dir mtime (ms) — recency guard against reaping a mid-spawn worktree. */
	mtimeMs: number;
	/** Has uncommitted changes. */
	dirty: boolean;
	/** The repo's primary worktree (the main checkout) — never reaped. */
	isPrimary: boolean;
}

export interface ReapInput {
	worktrees: WorktreeInfo[];
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
	/** Commit uncommitted changes to the branch before removing the worktree. */
	preserveWip: boolean;
	/** Delete the branch too — only when fully merged + clean, i.e. provably lossless. */
	deleteBranch: boolean;
}

/** Plane identifier embedded in a squad branch: "squad/ompsq-35-<suffix>" → "OMPSQ-35". `undefined` if none. */
export function parseIssueIdentifier(branch: string): string | undefined {
	const m = /^squad\/([a-z][a-z0-9]*-\d+)-/i.exec(branch);
	return m ? m[1].toUpperCase() : undefined;
}

/** Decide which unowned, dead worktrees to reap. See module header for the safety contract. */
export function selectReapable(input: ReapInput): ReapDecision[] {
	const out: ReapDecision[] = [];
	for (const w of input.worktrees) {
		if (w.isPrimary || !w.branch) continue; // never the main checkout; skip detached (no branch to anchor)
		if (input.owned.has(w.worktree)) continue; // a live agent owns it
		if (input.now - w.mtimeMs < input.graceMs) continue; // mid-spawn / recently active — leave it
		const merged = w.aheadOfBase === 0; // <0 (unknown) is NOT merged ⇒ never reap on a failed ahead-count
		const ident = parseIssueIdentifier(w.branch);
		const issueClosed = input.openIdentifiers !== null && ident !== undefined && !input.openIdentifiers.has(ident);
		if (!merged && !issueClosed) continue; // has unique work and issue still open ⇒ keep
		out.push({
			worktree: w.worktree,
			branch: w.branch,
			reason: merged ? "merged" : "issue-closed",
			preserveWip: w.dirty,
			// Committing WIP makes a merged branch unmerged again, so only delete when there is nothing to preserve.
			deleteBranch: merged && !w.dirty,
		});
	}
	return out;
}
