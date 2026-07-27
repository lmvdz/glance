/**
 * Single plan-doc read + git-revision helpers for the design-review screen.
 *
 * The review screen needs two things `parsePlanDocuments` (features.ts) doesn't give it:
 * 1. A single-file, path-guarded read (so a client can ask for one doc without pulling the whole
 *    feature pipeline payload).
 * 2. "What changed since I last looked" — the doc lives in git, so its revision history IS its
 *    edit history (no separate audit trail needed). v1 diffs the current working tree against a
 *    single named revision (the last-seen SHA the client persisted) rather than streaming live
 *    edits — see plan-doc-review.ts on the client for the "mark as viewed" protocol this serves.
 *
 * Every git call routes through hardenedGit (git-harden.ts) — the single hardened shell-out
 * boundary — same discipline as explore.ts's worktreeDiff/worktreeTree.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hardenedGit } from "./git-harden.ts";

/** Resolve `docPath` (relative, e.g. "plans/foo/01-bar.md") under `repo`, refusing any escape
 *  via ".." or an absolute path — mirrors features.ts's concernDocStatus guard. Returns the
 *  absolute path, or undefined when it would escape the repo root. */
export function resolveSafeDocPath(repo: string, docPath: string): string | undefined {
	const abs = path.resolve(repo, docPath);
	const root = path.resolve(repo) + path.sep;
	return abs.startsWith(root) ? abs : undefined;
}

/**
 * True iff `docPath` is a plan MARKDOWN doc: repo-relative (never absolute), rooted at `plans/`, no
 * `..` traversal, and ending in `.md` (case-insensitive). This is the KEYSTONE gate for commit-on-pass
 * (PLAN-VOTE-COMMIT.md security review HIGH 1): a plan-vote's PASSED outcome commits `docPath`'s
 * content into the shared checkout, bypassing the code-land gate — so the path it may ever touch MUST
 * be constrained to plan markdown under `plans/`, never a source/config file. Enforced at BOTH
 * candidate creation (reject at the source) AND immediately before the commit (never trust a stored
 * path). Uses POSIX-normalized segments so a Windows-style separator or a `.` segment can't sneak
 * past. Deliberately does NOT touch the filesystem — a pure lexical predicate, safe to call anywhere.
 */
export function isPlanDocPath(docPath: string): boolean {
	if (typeof docPath !== "string" || docPath.length === 0) return false;
	if (path.isAbsolute(docPath)) return false;
	const norm = docPath.replaceAll("\\", "/");
	if (!norm.toLowerCase().endsWith(".md")) return false;
	const segments = norm.split("/");
	if (segments[0] !== "plans") return false; // must be rooted at plans/
	if (segments.length < 2) return false; // "plans" alone (or "plans/") is a dir, not a doc
	// No traversal or empty/current-dir segments anywhere (…/../…, //, /./).
	for (const seg of segments) {
		if (seg === "" || seg === "." || seg === "..") return false;
	}
	return true;
}

export interface PlanDocRead {
	path: string;
	content: string;
	/** Latest commit SHA touching this path, or "" when the repo has no history for it (a new,
	 *  uncommitted doc, or `repo` isn't a git worktree at all). */
	sha: string;
}

/** The working-tree content of one plan doc, plus the newest commit SHA that touched it. */
export async function readPlanDoc(repo: string, docPath: string): Promise<PlanDocRead | undefined> {
	const abs = resolveSafeDocPath(repo, docPath);
	if (!abs) return undefined;
	const content = await fs.readFile(abs, "utf8").catch(() => undefined);
	if (content === undefined) return undefined;
	const sha = await planDocHeadRevision(repo, docPath);
	return { path: docPath, content, sha };
}

/** Newest commit SHA touching `docPath` in `repo`, or "" (no history / not a git repo). */
export async function planDocHeadRevision(repo: string, docPath: string): Promise<string> {
	const abs = resolveSafeDocPath(repo, docPath);
	if (!abs) return "";
	const r = await hardenedGit(["-C", repo, "log", "-1", "--format=%H", "--", docPath]);
	return r.code === 0 ? r.stdout.trim() : "";
}

export interface PlanDocDiff {
	/** Unified diff, `since` (or the doc's first commit) → the current working tree, for `docPath`
	 *  alone. Empty string when there's nothing to diff (unknown `since`, or no change). */
	diff: string;
	sha: string;
}

/**
 * Unified diff between a named revision (`since`, e.g. a client's last-seen SHA) and the current
 * working tree, scoped to one file. `since` must be a real commit SHA the client previously read
 * from `readPlanDoc`/`planDocHeadRevision` — an unrecognized ref yields an empty diff rather than
 * throwing. Diffing against the working tree (not `since`..HEAD) means uncommitted edits show too.
 */
export async function planDocDiffSince(repo: string, docPath: string, since: string): Promise<PlanDocDiff> {
	const abs = resolveSafeDocPath(repo, docPath);
	const sha = await planDocHeadRevision(repo, docPath);
	if (!abs || !since.trim()) return { diff: "", sha };
	// Confirm `since` actually resolves in this repo before diffing — a stale/foreign SHA (e.g. the
	// doc's history was rewritten, or the client cached a SHA from a different clone) must degrade
	// to "no diff available", never a git error surfaced to the client.
	const check = await hardenedGit(["-C", repo, "cat-file", "-e", `${since}^{commit}`]);
	if (check.code !== 0) return { diff: "", sha };
	const r = await hardenedGit(["-C", repo, "diff", "--no-ext-diff", since.trim(), "--", docPath]);
	return { diff: r.code === 0 || r.code === 1 ? r.stdout : "", sha };
}

/**
 * The plan a unit is asking you to approve, read from its OWN worktree.
 *
 * This exists because of a defect found by using the product: a unit raised an "Approve plan" gate
 * whose entire payload was `{title, options:["Approve","Revise"]}` — no plan, no body, no pointer to
 * one. The plan was real; the agent had just written it to `plan.md` in its worktree and said so in
 * its transcript. There was simply no way to look at it from the question.
 *
 * The root is supplied by the DAEMON from the agent record, never by the caller — `readPlanDoc`'s
 * `repo` parameter is caller-controlled on its HTTP route, and an approve-gate must not become a way
 * to name an arbitrary directory. `resolveSafeDocPath` still guards containment as a second check.
 *
 * Candidate names, newest first by mtime. Deliberately a small fixed list rather than a glob: a unit
 * that wrote its plan somewhere unusual gets "no plan found", which is honest, instead of this
 * returning whatever markdown happened to be nearest.
 */
export async function readUnitPlan(worktree: string | undefined): Promise<PlanDocRead | undefined> {
	if (!worktree?.trim()) return undefined;
	const candidates = ["plan.md", "PLAN.md", ".plan.md", "IMPLEMENTATION.md", "docs/plan.md"];
	let best: { doc: PlanDocRead; at: number } | undefined;
	for (const name of candidates) {
		const abs = resolveSafeDocPath(worktree, name);
		if (!abs) continue;
		const stat = await fs.stat(abs).catch(() => undefined);
		if (!stat?.isFile()) continue;
		const content = await fs.readFile(abs, "utf8").catch(() => undefined);
		if (content === undefined) continue;
		const at = stat.mtimeMs;
		if (!best || at > best.at) best = { doc: { path: name, content, sha: "" }, at };
	}
	return best?.doc;
}
