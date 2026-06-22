/**
 * Worktree reaper policy — `selectReapable` decides which orphan worktrees are safe to
 * remove. The guards that matter: never a live/owned or primary worktree, never one inside
 * the spawn grace window (create() makes the worktree before the roster entry), reap only on
 * merged-into-base OR closed-Plane-issue, and stay lossless (preserve WIP, delete a branch
 * only when merged + clean). A failed ahead-count (-1) must never read as "merged".
 */

import { expect, test } from "bun:test";
import { parseIssueIdentifier, selectReapable, type ReapInput, type WorktreeInfo } from "../src/worktree-reaper.ts";

const NOW = 1_000_000;
const GRACE = 120_000;

const wt = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
	worktree: "/wt/a",
	branch: "squad/ompsq-35-aaaa-bbbb",
	aheadOfBase: 0,
	mtimeMs: NOW - GRACE - 1, // old by default ⇒ past the grace window
	dirty: false,
	isPrimary: false,
	...over,
});

const run = (worktrees: WorktreeInfo[], over: Partial<ReapInput> = {}) =>
	selectReapable({ worktrees, owned: new Set(), openIdentifiers: new Set(), now: NOW, graceMs: GRACE, ...over });

test("parseIssueIdentifier pulls PREFIX-N from a squad branch, ignores non-issue branches", () => {
	expect(parseIssueIdentifier("squad/ompsq-35-mqpp4ic2-osrh")).toBe("OMPSQ-35");
	expect(parseIssueIdentifier("squad/dagon-263-x-y")).toBe("DAGON-263");
	expect(parseIssueIdentifier("squad/agent-1")).toBeUndefined(); // no random suffix ⇒ not an issue ref
	expect(parseIssueIdentifier("main")).toBeUndefined();
});

test("merged + clean orphan is reaped and its branch deleted", () => {
	const d = run([wt({ aheadOfBase: 0, dirty: false })]);
	expect(d).toHaveLength(1);
	expect(d[0]).toMatchObject({ reason: "merged", preserveWip: false, deleteBranch: true });
});

test("merged but dirty: WIP preserved, branch kept (committing makes it unmerged)", () => {
	const d = run([wt({ aheadOfBase: 0, dirty: true })]);
	expect(d[0]).toMatchObject({ reason: "merged", preserveWip: true, deleteBranch: false });
});

test("unmerged but issue closed: reaped, branch kept (work preserved)", () => {
	// branch ahead of base, identifier OMPSQ-35 absent from the open set ⇒ issue closed
	const d = run([wt({ aheadOfBase: 3 })], { openIdentifiers: new Set(["OMPSQ-34"]) });
	expect(d[0]).toMatchObject({ reason: "issue-closed", deleteBranch: false });
});

test("unmerged + issue still open ⇒ kept", () => {
	const d = run([wt({ aheadOfBase: 3 })], { openIdentifiers: new Set(["OMPSQ-35"]) });
	expect(d).toHaveLength(0);
});

test("owned (live agent) worktree is never reaped, even when merged", () => {
	const d = run([wt({ worktree: "/wt/live", aheadOfBase: 0 })], { owned: new Set(["/wt/live"]) });
	expect(d).toHaveLength(0);
});

test("primary checkout is never reaped", () => {
	const d = run([wt({ isPrimary: true, aheadOfBase: 0 })]);
	expect(d).toHaveLength(0);
});

test("worktree inside the spawn grace window is never reaped (create() race guard)", () => {
	const d = run([wt({ mtimeMs: NOW - 1, aheadOfBase: 0 })]); // mtime just now
	expect(d).toHaveLength(0);
});

test("failed ahead-count (-1) does not read as merged; only issue-closed can reap it", () => {
	// Plane unknown (null) + unknown ahead ⇒ nothing safe to conclude ⇒ kept.
	expect(run([wt({ aheadOfBase: -1 })], { openIdentifiers: null })).toHaveLength(0);
	// Same worktree, but the issue is provably closed ⇒ reaped, branch kept (not "merged").
	const d = run([wt({ aheadOfBase: -1 })], { openIdentifiers: new Set() });
	expect(d[0]).toMatchObject({ reason: "issue-closed", deleteBranch: false });
});

test("Plane unreachable (null) falls back to merged-only reaping", () => {
	const merged = wt({ worktree: "/wt/m", aheadOfBase: 0 });
	const unmerged = wt({ worktree: "/wt/u", aheadOfBase: 2 });
	const d = run([merged, unmerged], { openIdentifiers: null });
	expect(d.map((x) => x.worktree)).toEqual(["/wt/m"]);
});

test("detached worktree (no branch) is skipped", () => {
	const d = run([wt({ branch: "", aheadOfBase: 0 })]);
	expect(d).toHaveLength(0);
});
