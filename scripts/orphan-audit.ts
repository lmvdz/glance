#!/usr/bin/env bun
/**
 * Orphan-PR audit — deterministic guard against this repo's own recurring incident: a PR shows
 * MERGED on GitHub, but its content never actually reached `main`. Found FIVE times so far by manual
 * session audits (MEMORY.md "omp-squad orphaned merged-PR audit" and friends) before this existed —
 * this makes detection repeatable instead of relying on a human noticing.
 *
 * Algorithm, per recently-merged PR (`gh pr list --state merged`):
 *   1. Skip (report, don't fail) if the head branch no longer exists on origin — nothing left to
 *      check, and a deleted branch is the NORMAL post-land cleanup case, not a symptom.
 *   2. `git cherry origin/<default> origin/<head>` (src/orphan-audit.ts's `cherryCheck`) — `+`
 *      entries are commits on the head branch with no equivalent-patch commit already in
 *      `origin/<default>`. This is deliberately NOT the same question as `git merge-base
 *      --is-ancestor <headTip> origin/<default>`: ancestry only proves the CURRENT branch tip is
 *      reachable, which can hold even though (a) the branch grew MORE commits after the PR merged
 *      that were never picked up, or (b) a stacked PR's merge commit reached `main` via its parent
 *      while its OWN later work on the same branch never did. `git cherry` catches both; ancestry
 *      catches neither.
 *   3. Classify each `+` SHA's suspected cause (src/orphan-audit.ts's `classifyOrphanCause`):
 *      committer-date-after-mergedAt ⇒ post-merge stranding; base != default ⇒ stacked-PR; else
 *      unknown (investigate manually) — an honest fallback, never a fabricated diagnosis.
 *
 * Exits 1 (prints a table) when ANY orphan is found; exits 0 ("0 orphans") when the swept PRs are
 * all clean; exits 2 when the audit itself couldn't run (no `gh`, not a git repo, rate-limited PR
 * enumeration) — deliberately distinct from "ran clean" and "found orphans" so a caller can tell
 * "the guard didn't run" from "the guard ran and passed".
 *
 * Usage: bun scripts/orphan-audit.ts [--limit N] [--base <branch>] [--repo <path>]
 *   --limit N     how many recently-merged PRs to sweep (default 50)
 *   --base BRANCH override default-branch detection (normally read from `gh repo view`)
 *   --repo PATH   repo to audit (default: cwd)
 */

import { hardenedGit } from "../src/git-harden.ts";
import { ghJson } from "../src/gh.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import { cherryCheck, classifyOrphanCause, orphanedShas } from "../src/orphan-audit.ts";

export interface MergedPr {
	number: number;
	headRefName: string;
	baseRefName: string;
	url: string;
	mergedAt?: string;
	mergeCommit?: { oid: string };
}

export interface OrphanRow {
	branch: string;
	prNumber: number;
	prUrl: string;
	sha: string;
	cause: string;
}

export interface SkippedPr {
	branch: string;
	prNumber: number;
	reason: string;
}

export interface AuditReport {
	defaultBranch: string;
	prsSwept: number;
	skipped: SkippedPr[];
	orphans: OrphanRow[];
}

/** "owner/repo" from repoIdentity()'s "host/owner/repo" key — mirrors land-pr.ts's own `slugOf`
 *  (deliberately re-derived here rather than imported: land-pr.ts keeps that helper private, same
 *  small-private-surface convention this codebase already follows for `git`/`runGate`). */
function slugOf(repo: string): string {
	return repoIdentity(repo).split("/").slice(-2).join("/");
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const r = await hardenedGit(args, { cwd });
	return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** `gh repo view --json defaultBranchRef`, falling back to "main" — best-effort, never throws. */
export async function resolveDefaultBranch(repo: string, override?: string): Promise<string> {
	if (override) return override;
	const view = await ghJson<{ defaultBranchRef?: { name: string } }>(["repo", "view", slugOf(repo), "--json", "defaultBranchRef"], repo);
	return view?.defaultBranchRef?.name ?? "main";
}

export async function listMergedPrs(repo: string, limit: number): Promise<MergedPr[] | undefined> {
	return ghJson<MergedPr[]>(["pr", "list", "--state", "merged", "--repo", slugOf(repo), "--json", "number,headRefName,baseRefName,url,mergedAt,mergeCommit", "--limit", String(limit)], repo);
}

/** Committer date (ISO 8601) of `sha`, or undefined if the object can't be resolved locally. */
async function commitDate(repo: string, sha: string): Promise<string | undefined> {
	const r = await git(["log", "-1", "--format=%cI", sha], repo);
	return r.code === 0 && r.stdout ? r.stdout : undefined;
}

/** Audit one merged PR: skip if its head branch is gone from origin, else cherry-check + classify. */
export async function auditPr(repo: string, pr: MergedPr, defaultBranch: string): Promise<{ skipped?: SkippedPr; orphans: OrphanRow[] }> {
	const headRef = `origin/${pr.headRefName}`;
	const exists = await git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${pr.headRefName}`], repo);
	if (exists.code !== 0) {
		return { skipped: { branch: pr.headRefName, prNumber: pr.number, reason: "head branch no longer exists on origin (deleted post-merge — normal cleanup)" }, orphans: [] };
	}

	const check = await cherryCheck(`origin/${defaultBranch}`, headRef, repo);
	if (!check.ok) {
		return { skipped: { branch: pr.headRefName, prNumber: pr.number, reason: `git cherry failed: ${check.error}` }, orphans: [] };
	}

	const shas = orphanedShas(check.entries);
	const orphans: OrphanRow[] = [];
	for (const sha of shas) {
		const commitDateIso = await commitDate(repo, sha);
		const cause = classifyOrphanCause({ commitDateIso, prMergedAtIso: pr.mergedAt, prBaseRefName: pr.baseRefName, defaultBranch });
		orphans.push({ branch: pr.headRefName, prNumber: pr.number, prUrl: pr.url, sha, cause });
	}
	return { orphans };
}

export interface RunOpts {
	repo?: string;
	limit?: number;
	base?: string;
}

/** Full sweep: enumerate merged PRs, fetch fresh, audit each still-live head branch. Returns
 *  `undefined` only when PR enumeration itself failed (no `gh`, auth, rate limit) — the caller
 *  degrades that to exit 2, distinct from "swept clean" (exit 0) and "found orphans" (exit 1). */
export async function runAudit(opts: RunOpts = {}): Promise<AuditReport | undefined> {
	const repo = opts.repo ?? process.cwd();
	// A mangled `--limit` (NaN, 0, negative) degrades to the default rather than handing gh garbage.
	const limit = opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50;
	const defaultBranch = await resolveDefaultBranch(repo, opts.base);

	// Best-effort refresh so origin/<head> refs reflect reality (a stale remote-tracking ref would
	// either miss a real orphan or false-alarm on one already cleaned up elsewhere) — a failed fetch
	// (offline, transient network) is reported but not fatal: existing refs are still auditable.
	const fetch = await git(["fetch", "origin", "--prune", "-q"], repo);
	if (fetch.code !== 0) console.error(`warning: git fetch origin --prune failed (auditing against possibly-stale refs): ${fetch.stderr}`);

	const prs = await listMergedPrs(repo, limit);
	if (prs === undefined) return undefined;

	const skipped: SkippedPr[] = [];
	const orphans: OrphanRow[] = [];
	for (const pr of prs) {
		const result = await auditPr(repo, pr, defaultBranch);
		if (result.skipped) skipped.push(result.skipped);
		orphans.push(...result.orphans);
	}

	return { defaultBranch, prsSwept: prs.length, skipped, orphans };
}

function parseArgs(argv: string[]): RunOpts {
	const opts: RunOpts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--limit") opts.limit = Number(argv[++i]);
		else if (a === "--base") opts.base = argv[++i];
		else if (a === "--repo") opts.repo = argv[++i];
	}
	return opts;
}

function printReport(report: AuditReport): void {
	console.log(`Orphan-PR audit — default branch "${report.defaultBranch}", ${report.prsSwept} merged PR(s) swept.`);
	if (report.skipped.length > 0) {
		console.log(`\n${report.skipped.length} skipped:`);
		for (const s of report.skipped) console.log(`  PR #${s.prNumber} (${s.branch}): ${s.reason}`);
	}
	if (report.orphans.length === 0) {
		console.log(`\n0 orphans. Every checked merged PR's content is reachable from origin/${report.defaultBranch}.`);
		return;
	}
	console.log(`\n${report.orphans.length} ORPHANED COMMIT(S) — content that never reached origin/${report.defaultBranch}:\n`);
	const byBranch = new Map<string, OrphanRow[]>();
	for (const o of report.orphans) {
		if (!byBranch.has(o.branch)) byBranch.set(o.branch, []);
		byBranch.get(o.branch)!.push(o);
	}
	for (const [branch, rows] of byBranch) {
		console.log(`  branch: ${branch}  (PR #${rows[0].prNumber}, ${rows[0].prUrl})`);
		for (const r of rows) {
			console.log(`    ${r.sha.slice(0, 12)}  ${r.cause}`);
		}
	}
}

if (import.meta.main) {
	const opts = parseArgs(process.argv.slice(2));
	const report = await runAudit(opts);
	if (report === undefined) {
		console.error("orphan audit FAILED to run: could not enumerate merged PRs (gh unavailable, unauthenticated, or rate-limited)");
		process.exit(2);
	}
	printReport(report);
	process.exit(report.orphans.length > 0 ? 1 : 0);
}
