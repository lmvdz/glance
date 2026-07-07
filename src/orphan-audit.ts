/**
 * Orphan-commit detection primitives — the ONE shared implementation behind both
 * `scripts/orphan-audit.ts` (the standalone CLI that enumerates recently-merged PRs and audits each
 * one) and `src/land-pr.ts`'s post-merge assertion (which checks the ONE branch it just merged,
 * synchronously, right after `gh pr merge`).
 *
 * Five separate manual-audit incidents (see MEMORY.md "omp-squad orphaned merged-PR audit" and
 * friends) found merged PRs whose content never reached `main` — either because a stacked PR's
 * parent branch itself never landed, or because a branch kept receiving commits AFTER its PR
 * merged and nobody re-PR'd the follow-up work. `git merge-base --is-ancestor <tip> origin/<default>`
 * (the check `land-pr.ts`'s `assertMerged` already runs) only proves the CURRENT tip is reachable —
 * it says nothing about commits added to the branch afterward, and for a stacked PR whose merge
 * commit legitimately reached `main` via its parent, ancestry can hold even though the branch's
 * OWN later work never did. `git cherry <upstream> <head>` answers a different, complementary
 * question: does EVERY commit reachable from `<head>` have an equivalent-patch commit already in
 * `<upstream>`? A `+` entry is content `<upstream>` has never seen — the orphan signal.
 *
 * Split into pure functions (`parseCherry`, `orphanedShas`, `classifyOrphanCause` — no I/O, fully
 * unit-testable) and one thin git-I/O wrapper (`cherryCheck`) that never throws, so a bad ref
 * (deleted branch, unfetched remote) degrades to a reported failure rather than crashing whichever
 * caller invoked it — the CLI keeps auditing the rest of the list, and `land-pr.ts`'s land does not
 * get blocked by it (the merge already happened).
 */

import { hardenedGit } from "./git-harden.ts";

export interface CherryEntry {
	/** `+` = no equivalent-patch commit found in upstream (orphan candidate). `-` = equivalent patch
	 *  already present in upstream (a rebase/cherry-pick landed the same change under a different SHA). */
	status: "+" | "-";
	sha: string;
}

/**
 * Parse `git cherry <upstream> <head>` porcelain output. Pure — no I/O, no throw. Each line is
 * `<+|-> <sha> <subject...>`; malformed/blank lines are skipped rather than failing the whole parse
 * (git's own format is stable, but a caller could hand this arbitrary text in a test).
 */
export function parseCherry(output: string): CherryEntry[] {
	const entries: CherryEntry[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const m = /^([+-])\s+([0-9a-f]{7,40})\b/.exec(line);
		if (m) entries.push({ status: m[1] as "+" | "-", sha: m[2] });
	}
	return entries;
}

/** SHAs `git cherry` marked `+` — commits on `head` with no equivalent patch in `upstream`. */
export function orphanedShas(entries: CherryEntry[]): string[] {
	return entries.filter((e) => e.status === "+").map((e) => e.sha);
}

export interface CherryCheckResult {
	/** false ⇒ the git command itself failed (bad ref, branch/upstream not fetched, git error) —
	 *  `entries` is empty and NOT authoritative; callers must not read "0 orphans" out of this. */
	ok: boolean;
	entries: CherryEntry[];
	error?: string;
}

/**
 * Run `git cherry <upstream> <head>` in `cwd` and parse it. Never throws: a missing ref or any other
 * git failure surfaces as `{ ok: false, error }` instead, so callers can tell "checked, clean" from
 * "couldn't check" — collapsing the two would either false-alarm on every deleted/unfetched branch
 * or silently swallow a real orphan behind a git error.
 */
export async function cherryCheck(upstream: string, head: string, cwd: string): Promise<CherryCheckResult> {
	const r = await hardenedGit(["cherry", upstream, head], { cwd });
	if (r.code !== 0) {
		return { ok: false, entries: [], error: r.stderr.trim() || r.stdout.trim() || `git cherry ${upstream} ${head} exited ${r.code}` };
	}
	return { ok: true, entries: parseCherry(r.stdout) };
}

export interface ClassifyInput {
	/** Committer date of the orphaned commit, ISO 8601 (`git log --format=%cI`). Undefined ⇒ unknown. */
	commitDateIso?: string;
	/** The PR's `mergedAt` from `gh pr list --json mergedAt`, ISO 8601. Undefined ⇒ unknown (e.g. a
	 *  local-only check with no PR metadata, as `land-pr.ts`'s live assertion has). */
	prMergedAtIso?: string;
	/** The PR's base branch (`gh pr list --json baseRefName`). Undefined ⇒ assume it targeted `defaultBranch`. */
	prBaseRefName?: string;
	defaultBranch: string;
}

/**
 * Best-effort "why is this commit orphaned" classification — encodes the two known-pitfall causes
 * from the repo's own audit history, falling back to an honest "unknown" rather than guessing.
 * Pure — every input is already-resolved data, no I/O here.
 */
export function classifyOrphanCause(input: ClassifyInput): string {
	const { commitDateIso, prMergedAtIso, prBaseRefName, defaultBranch } = input;
	if (commitDateIso && prMergedAtIso) {
		const commitTime = Date.parse(commitDateIso);
		const mergedTime = Date.parse(prMergedAtIso);
		if (Number.isFinite(commitTime) && Number.isFinite(mergedTime) && commitTime > mergedTime) {
			return "pushed to branch AFTER the PR merged — post-merge stranding (the merged PR's diff was honest; later work on the same branch was never re-PR'd)";
		}
	}
	if (prBaseRefName && prBaseRefName !== defaultBranch) {
		return `stacked PR based on "${prBaseRefName}", not "${defaultBranch}" — verify "${prBaseRefName}" itself reached "${defaultBranch}"`;
	}
	return `unknown — merge-base ancestry can say the tip landed, but this commit's patch is missing from "${defaultBranch}"; investigate manually`;
}
