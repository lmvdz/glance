/**
 * Conflict-marker gate (#330, per #327's resolution) — hardened in gauntlet round 1 against PR #351
 * (dual-lineage, codex gpt-5.6-sol + grok-4.5). Drives every exported function against REAL
 * throwaway git repos, the same style as tests/land-risk.test.ts. Sections below are grouped by the
 * same finding numbers as the gauntlet report.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	conflictMarkerGateEnabled,
	conflictMarkerReasonForFiles,
	conflictMarkerReasonForRange,
	conflictMarkerReasonStaged,
	MARKER_EXEMPT_TOKEN,
} from "../src/conflict-markers.ts";

let repo: string;

function sh(args: string[], cwd = repo): void {
	const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "ignore", stderr: "ignore" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
function shOut(args: string[], cwd = repo): string {
	const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	return new TextDecoder().decode(p.stdout).trim();
}

function commitFiles(files: Record<string, string>, msg: string): void {
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(repo, rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	}
	sh(["add", "-A"]);
	sh(["commit", "-m", msg]);
}

beforeEach(() => {
	repo = mkdtempSync(path.join(tmpdir(), "conflictmarkers-"));
	sh(["init", "-q", "-b", "main"]);
	commitFiles({ "README.md": "seed\n" }, "seed");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

// ── conflictMarkerReasonForRange: basic behavior ───────────────────────────────────────────────

test("a clean diff is not flagged", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "src/a.ts": "export const a = 1;\n", "docs/notes.md": "# Notes\n\nordinary prose.\n" }, "clean change");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

test("a live conflict marker added to a changed .md file is refused", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/plan.md": ["# Plan", "", "<<<<<<< HEAD", "keep the old approach", "=======", "switch to the new approach", ">>>>>>> feat", ""].join("\n") }, "resolver left markers behind");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("conflict-markers gate:");
	expect(r).toContain("docs/plan.md");
	expect(r).toContain("<<<<<<< HEAD");
	expect(r).toContain("refusing to land");
});

test("a live conflict marker in a changed .json file is refused too (parses fine, still debris)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "config/settings.json": '{\n<<<<<<< HEAD\n  "mode": "old"\n=======\n  "mode": "new"\n>>>>>>> feat\n}\n' }, "resolver left markers in json");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("config/settings.json");
});

test("escape hatch: a pre-existing marker-looking line outside the scanned range is NOT flagged", async () => {
	commitFiles({ "docs/teaching.md": ["# What a conflict looks like", "", "<<<<<<< HEAD", "old", "=======", "new", ">>>>>>> theirs", ""].join("\n") }, "pre-existing teaching doc");
	const head0 = shOut(["rev-parse", "HEAD"]); // AFTER the teaching doc — the range starts past it
	commitFiles({ "src/unrelated.ts": "export const x = 1;\n" }, "unrelated change");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

test("a lone '=======' with no start/end/base marker is NOT flagged (Markdown Setext heading underline)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/compare.md": ["Compare", "=======", "", "ordinary setext-style heading, not a conflict.", ""].join("\n") }, "markdown heading");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

test("a '=======' IS flagged once the same file also adds a start or end marker", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/plan.md": ["<<<<<<< HEAD", "old", "=======", "new", ">>>>>>> feat", ""].join("\n") }, "full marker triple");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("=======");
});

test("prose mentioning marker characters mid-line is not flagged", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/skill.md": "The --verify gate must include a conflict-marker grep (e.g. grep -rn '^<<<<<<<' src/).\n" }, "doc describing the check");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

// ── gauntlet #9: over-scan fixed by scanning the actual (fromRef, toRef) range, not a merge-base ──

test("gauntlet #9: content that independently converges on both sides is not over-scanned (post-range, not stale merge-base)", async () => {
	// branch adds docs/example.md with markers, forked from the seed commit.
	sh(["checkout", "-q", "-b", "feat"]);
	const markerContent = ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n");
	commitFiles({ "docs/example.md": markerContent }, "feat adds example.md with markers");
	sh(["checkout", "-q", "main"]);
	// main independently gains the IDENTICAL content at the SAME path (e.g. two branches scaffolding
	// the same boilerplate) — by land time, merging feat introduces NOTHING new for this file.
	commitFiles({ "docs/example.md": markerContent }, "main independently gains identical content");
	const preMergeMain = shOut(["rev-parse", "HEAD"]);
	sh(["merge", "-q", "--no-ff", "feat", "-m", "merge feat"]);
	// A stale-merge-base scan (merge-base(main,feat)..feat) would still show docs/example.md as
	// "added by feat" relative to the OLD fork point — over-scanning content that already converged.
	// The real question is what THIS merge introduces relative to the CURRENT target tip:
	expect(await conflictMarkerReasonForRange(repo, preMergeMain, "HEAD")).toBeUndefined();
});

// ── gauntlet #5/#6: variable-width markers + the diff3/zdiff3 base marker ─────────────────────────

test("gauntlet #5: a conflict-marker-size=10 (10-char markers) conflict is still caught", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	const ten = "<".repeat(10);
	const tenEq = "=".repeat(10);
	const tenGt = ">".repeat(10);
	commitFiles({ "docs/wide.md": [`${ten} HEAD`, "ours", tenEq, "theirs", `${tenGt} feat`, ""].join("\n") }, "10-char markers (conflict-marker-size=10)");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("docs/wide.md");
	expect(r).toContain(ten);
});

test("gauntlet #6: the diff3/zdiff3 base marker (pipe run) is detected", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	const base = "|".repeat(7);
	commitFiles({ "docs/diff3.md": ["<<<<<<< HEAD", "ours", `${base} base`, "common ancestor", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "diff3-style conflict left behind");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain(`${base} base`);
});

// ── gauntlet #3/#4: hardened diff invocation ───────────────────────────────────────────────────

test("gauntlet #3: an inherited color.ui=always repo config does not blind the scanner", async () => {
	sh(["config", "color.ui", "always"]);
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/plan.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "markers under color.ui=always");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("docs/plan.md");
});

test("gauntlet #4: a .gitattributes marking the path binary (-diff) does not hide its content", async () => {
	commitFiles({ ".gitattributes": "*.md -diff\n" }, "mark markdown as binary for diff purposes");
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/plan.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "markers in a -diff-attributed path");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("docs/plan.md");
});

// ── gauntlet #7: allowlist (paths + in-file exempt token) ─────────────────────────────────────────

test("gauntlet #7: a tests/fixtures/ path carrying real markers is ALLOWED (path allowlist)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "tests/fixtures/conflict-example.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "new fixture teaching about markers");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

test("gauntlet #7: a .patch file carrying real markers is ALLOWED (extension allowlist)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "hotfix.patch": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "a literal patch file");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

test("gauntlet #7: a non-allowlisted doc carrying the in-file exempt token is ALLOWED", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles(
		{ "docs/landing.md": [`<!-- ${MARKER_EXEMPT_TOKEN} -->`, "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") },
		"doc that must show real marker syntax, carries the exempt token",
	);
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeUndefined();
});

test("without the exempt token, the SAME non-allowlisted content is refused (control)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "docs/landing.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "same content, no exempt token");
	expect(await conflictMarkerReasonForRange(repo, head0, "HEAD")).toBeDefined();
});

// ── probe failures / default-on ────────────────────────────────────────────────────────────────

test("a bogus ref never throws — but is BLOCKED (fail-closed), not silently clean", async () => {
	const r = await conflictMarkerReasonForRange(repo, "does-not-exist", "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("conflict-markers gate:");
	expect(r).toContain("could not scan");
});

test("an unreadable repo never throws — but is BLOCKED (fail-closed), not silently clean", async () => {
	const r = await conflictMarkerReasonForRange("/no/such/repo", "HEAD~1", "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("conflict-markers gate:");
	expect(r).toContain("could not scan");
});

test("the gate is ON by default", () => {
	expect(conflictMarkerGateEnabled()).toBe(true);
	process.env.OMP_SQUAD_CONFLICT_MARKER_GATE = "0";
	try {
		expect(conflictMarkerGateEnabled()).toBe(false);
	} finally {
		delete process.env.OMP_SQUAD_CONFLICT_MARKER_GATE;
	}
});

// ── conflictMarkerReasonStaged (gauntlet #2: the in-place land path) ──────────────────────────────

test("conflictMarkerReasonStaged: a staged file with markers is refused before any commit", async () => {
	mkdirSync(path.join(repo, "docs"), { recursive: true });
	writeFileSync(path.join(repo, "docs", "plan.md"), ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n"));
	sh(["add", "-A"]);
	const r = await conflictMarkerReasonStaged(repo);
	expect(r).toBeDefined();
	expect(r).toContain("docs/plan.md");
	// Nothing was committed — the check ran BEFORE the commit, as designed.
	expect(shOut(["status", "--porcelain"])).not.toBe("");
});

test("conflictMarkerReasonStaged: a clean staged change is not flagged", async () => {
	writeFileSync(path.join(repo, "src.ts"), "export const a = 1;\n");
	sh(["add", "-A"]);
	expect(await conflictMarkerReasonStaged(repo)).toBeUndefined();
});

// ── conflictMarkerReasonForFiles (gauntlet #8: AUTORESOLVE full-file scan) ────────────────────────

test("gauntlet #8: debris reusing a PRE-EXISTING marker triple as context is caught by a full-file scan (added-lines would miss it)", async () => {
	// An old teaching triple already exists — the OUTER markers themselves are untouched by the
	// resolver's edit; only the INNER content line changes. An added-lines diff would show only that
	// one inner line (not itself a marker), missing the fact the file is still a live conflict block.
	commitFiles({ "docs/teaching.md": ["<<<<<<< HEAD", "old inner content", "=======", "new inner content", ">>>>>>> feat", ""].join("\n") }, "pre-existing teaching triple");
	const ref = shOut(["rev-parse", "HEAD"]);
	const r = await conflictMarkerReasonForFiles(repo, ref, ["docs/teaching.md"]);
	expect(r).toBeDefined();
	expect(r).toContain("docs/teaching.md");
});

test("conflictMarkerReasonForFiles: a clean resolved file is not flagged", async () => {
	commitFiles({ "docs/plan.md": "properly resolved content\n" }, "clean resolution");
	const ref = shOut(["rev-parse", "HEAD"]);
	expect(await conflictMarkerReasonForFiles(repo, ref, ["docs/plan.md"])).toBeUndefined();
});

test("conflictMarkerReasonForFiles: allowlisted paths are exempt even under a full-file scan", async () => {
	commitFiles({ "tests/fixtures/example.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "fixture");
	const ref = shOut(["rev-parse", "HEAD"]);
	expect(await conflictMarkerReasonForFiles(repo, ref, ["tests/fixtures/example.md"])).toBeUndefined();
});

test("conflictMarkerReasonForFiles: an empty file list is never flagged (nothing to scan)", async () => {
	expect(await conflictMarkerReasonForFiles(repo, "HEAD", [])).toBeUndefined();
});
