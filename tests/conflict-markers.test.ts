/**
 * Conflict-marker gate (#330, per #327's resolution) — hardened in gauntlet round 1 AND the
 * delta-verify round against PR #351 (dual-lineage, codex gpt-5.6-sol + grok-4.5). Drives every
 * exported function against REAL throwaway git repos, the same style as tests/land-risk.test.ts.
 * Sections below are grouped by the same finding numbers as the gauntlet reports.
 *
 * Delta-verify round (CRITICAL, both lineages): round 1's path allowlist and MARKER_EXEMPT_TOKEN
 * were both agent-settable exemptions — the diff being scanned is authored by the very thing the
 * gate guards against, so no exemption it can set is acceptable. Both are DELETED; every marker hit
 * now refuses unconditionally, and the tests below that used to prove "allowed" now prove "refused".
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

// ── delta-verify #1 (CRITICAL, both lineages): the allowlist and exempt token are GONE ────────────
// Round 1 shipped a path allowlist and an in-file token as agent-writable exemptions — the candidate
// diff is authored by the thing the gate guards against, so both were a self-serve bypass. Deleted;
// every one of these now REFUSES (the cases below used to assert `toBeUndefined()`).

test("delta-verify #1: a tests/fixtures/ path carrying real markers is now REFUSED (path allowlist deleted)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "tests/fixtures/conflict-example.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "an agent writes real debris under a formerly-allowlisted path");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("tests/fixtures/conflict-example.md");
});

test("delta-verify #1: a .patch file carrying real markers is now REFUSED (extension allowlist deleted)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "hotfix.patch": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "a literal patch file");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("hotfix.patch");
});

test("delta-verify #1: a doc carrying what used to be the exempt-token string is now REFUSED (token deleted, no bypass)", async () => {
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles(
		{ "docs/landing.md": ["<!-- glance-conflict-marker-check:allow -->", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") },
		"an agent types the old magic comment string, which is no longer meaningful",
	);
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("docs/landing.md");
});

test("delta-verify #1: this module's OWN source, if it carried added marker debris, would be refused too (no self-exemption)", async () => {
	// Round 1's bug, made concrete: conflict-markers.ts itself contained the exempt token's literal
	// value, so debris added to THAT file would have self-exempted. Prove the file is judged like any
	// other now — no special-casing by path, filename, or content.
	const head0 = shOut(["rev-parse", "HEAD"]);
	commitFiles({ "src/conflict-markers.ts": ["export const X = 1;", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> feat", ""].join("\n") }, "debris added to the gate's own module");
	const r = await conflictMarkerReasonForRange(repo, head0, "HEAD");
	expect(r).toBeDefined();
	expect(r).toContain("src/conflict-markers.ts");
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

test("delta-verify #1: a tests/fixtures/ path is now REFUSED under the full-file scan too (path allowlist deleted everywhere)", async () => {
	commitFiles({ "tests/fixtures/example.md": ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feat", ""].join("\n") }, "fixture");
	const ref = shOut(["rev-parse", "HEAD"]);
	const r = await conflictMarkerReasonForFiles(repo, ref, ["tests/fixtures/example.md"]);
	expect(r).toBeDefined();
	expect(r).toContain("tests/fixtures/example.md");
});

test("conflictMarkerReasonForFiles: an empty file list is never flagged (nothing to scan)", async () => {
	expect(await conflictMarkerReasonForFiles(repo, "HEAD", [])).toBeUndefined();
});

// ── delta-verify #2 continued (codex, LOW): an unreadable touched file fails CLOSED, not skip ─────
// #355 polish round refined WHICH `git show` failures fail closed — see the tests below this section.

test("conflictMarkerReasonForFiles: a mix of one readable-clean and one genuinely-absent file lands (the absent one is a no-op, not a refusal)", async () => {
	commitFiles({ "docs/plan.md": "clean\n" }, "clean file");
	const ref = shOut(["rev-parse", "HEAD"]);
	// docs/does-not-exist.md was never committed at ref — same tree-absence shape as a delete-resolution
	// (#355): there is no content there at all, so it cannot carry marker debris either.
	expect(await conflictMarkerReasonForFiles(repo, ref, ["docs/plan.md", "docs/does-not-exist.md"])).toBeUndefined();
});

// ── #355: the delete-resolution false positive + its generalizing "flip the input" pair ───────────
// The MEDIUM false-positive this ticket closes: `land.ts`'s AUTORESOLVE loop puts every path that
// was EVER unresolved (`--diff-filter=U`) into `touchedFiles`, including one the resolver resolved
// BY DELETING the file outright. That path stays in the set; `git show branch:path` then fails
// (nothing there to show) and the OLD fail-closed rule refused the land even though there is no
// possible marker debris — the file is legitimately gone. The two tests below are the generalizing
// pair the ticket asks for: flip the input (a deleted path vs. a still-tracked-but-unreadable path)
// and confirm the gate's output differs correctly.

test("#355: a conflict resolved by DELETING the file lands (no content, no possible debris, not a fail-closed refusal)", async () => {
	// Simulates exactly what land.ts's touchedFiles carries after a delete-resolution: the path was
	// once tracked (so it's a REAL path, not a typo) but the final resolved tree has it deleted.
	commitFiles({ "docs/plan.md": "will be conflict-deleted\n" }, "seed the path that gets deleted");
	sh(["rm", "docs/plan.md"]);
	sh(["commit", "-m", "resolver resolves the conflict by deleting the file"]);
	const ref = shOut(["rev-parse", "HEAD"]);
	expect(await conflictMarkerReasonForFiles(repo, ref, ["docs/plan.md"])).toBeUndefined();
});

test("#355: a path that's still TRACKED but genuinely unreadable (a gitlink/submodule pointer) still fails CLOSED", async () => {
	// A gitlink (mode 160000, a submodule pointer) is a real, present tree entry — `ls-tree` lists it —
	// but `git show ref:path` can never read it as text ("fatal: bad object"): there is no blob to open.
	// This is the should-exist-but-unreadable shape #355 says must still refuse, distinct from a path
	// that's simply absent from the tree (the case above, which is safe to skip).
	const subRepo = mkdtempSync(path.join(tmpdir(), "conflictmarkers-sub-"));
	try {
		sh(["init", "-q", "-b", "main"], subRepo);
		sh(["config", "user.email", "t@t"], subRepo);
		sh(["config", "user.name", "t"], subRepo);
		writeFileSync(path.join(subRepo, "f.txt"), "hi\n");
		sh(["add", "-A"], subRepo);
		sh(["commit", "-qm", "sub"], subRepo);
		sh(["-c", "protocol.file.allow=always", "submodule", "add", subRepo, "sub"]);
		sh(["commit", "-m", "add a gitlink entry"]);
		const ref = shOut(["rev-parse", "HEAD"]);
		const r = await conflictMarkerReasonForFiles(repo, ref, ["sub"]);
		expect(r).toBeDefined();
		expect(r).toContain("conflict-markers gate:");
		expect(r).toContain("could not read sub");
	} finally {
		rmSync(subRepo, { recursive: true, force: true });
	}
});

test("#355: a wholly bogus ref still fails CLOSED for every touched file (never silently reads them all as \"deleted\")", async () => {
	const r = await conflictMarkerReasonForFiles(repo, "does-not-exist-ref", ["docs/plan.md"]);
	expect(r).toBeDefined();
	expect(r).toContain("conflict-markers gate:");
	expect(r).toContain("could not resolve does-not-exist-ref");
});
