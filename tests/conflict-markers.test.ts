/**
 * Conflict-marker gate (#330, per #327's resolution) — drives `conflictMarkerReason` against a REAL
 * throwaway git repo (not faked), the same style as tests/land-risk.test.ts. Exercises the exact
 * scenario the ticket names: AUTORESOLVE's LLM resolver (or a careless human) can leave live
 * `<<<<<<<`/`=======`/`>>>>>>>` debris in a `.md`/`.json`/`.txt` file that still compiles/parses fine,
 * which git's own structural conflict detection never catches.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { conflictMarkerGateEnabled, conflictMarkerReason } from "../src/conflict-markers.ts";

let repo: string;

function sh(args: string[], cwd = repo): void {
	const p = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "ignore", stderr: "ignore" });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
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

test("a clean diff is not flagged", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "src/a.ts": "export const a = 1;\n", "docs/notes.md": "# Notes\n\nordinary prose.\n" }, "clean change");
	sh(["checkout", "-q", "main"]);
	expect(await conflictMarkerReason(repo, "feat")).toBeUndefined();
});

// The exact scenario the ticket names: AUTORESOLVE's LLM resolver writes a .md file that still
// PARSES fine (no typecheck/test failure) while carrying live conflict-marker debris.
test("a live conflict marker added to a changed .md file is refused", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles(
		{
			"docs/plan.md": ["# Plan", "", "<<<<<<< HEAD", "keep the old approach", "=======", "switch to the new approach", ">>>>>>> feat", ""].join("\n"),
		},
		"resolver left markers behind",
	);
	sh(["checkout", "-q", "main"]);
	const r = await conflictMarkerReason(repo, "feat");
	expect(r).toBeDefined();
	expect(r).toContain("conflict-markers gate:");
	expect(r).toContain("docs/plan.md");
	expect(r).toContain("<<<<<<< HEAD");
	expect(r).toContain("refusing to land");
});

test("a live conflict marker in a changed .json file is refused too (compiles fine, still debris)", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	// Deliberately invalid JSON once markers are in it — the point is that NOTHING in a typecheck/test
	// gate would ever parse this file, so only a textual scan catches it.
	commitFiles({ "config/settings.json": '{\n<<<<<<< HEAD\n  "mode": "old"\n=======\n  "mode": "new"\n>>>>>>> feat\n}\n' }, "resolver left markers in json");
	sh(["checkout", "-q", "main"]);
	const r = await conflictMarkerReason(repo, "feat");
	expect(r).toBeDefined();
	expect(r).toContain("config/settings.json");
});

// ESCAPE HATCH #1 (the one this module implements): only ADDED lines are scanned. A marker-looking
// line that already existed BEFORE this branch (an old fixture, doc prose already on main) is
// completely untouched history and must never be flagged.
test("escape hatch: a pre-existing marker-looking line, unchanged by the branch, is NOT flagged", async () => {
	commitFiles({ "docs/teaching.md": ["# What a conflict looks like", "", "<<<<<<< HEAD", "old", "=======", "new", ">>>>>>> theirs", ""].join("\n") }, "pre-existing teaching doc, already on main");
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "src/unrelated.ts": "export const x = 1;\n" }, "unrelated change, doesn't touch the teaching doc");
	sh(["checkout", "-q", "main"]);
	expect(await conflictMarkerReason(repo, "feat")).toBeUndefined();
});

// ESCAPE HATCH #1 continued: even a branch that edits a DIFFERENT part of a file already carrying
// markers is fine, as long as it never ADDS a new marker line of its own.
test("escape hatch: editing OTHER lines in a file that already had markers doesn't trip the gate", async () => {
	commitFiles({ "docs/teaching.md": ["<<<<<<< HEAD", "old", "=======", "new", ">>>>>>> theirs", "", "Below is unrelated prose.", ""].join("\n") }, "pre-existing teaching doc");
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "docs/teaching.md": ["<<<<<<< HEAD", "old", "=======", "new", ">>>>>>> theirs", "", "Below is UPDATED unrelated prose.", ""].join("\n") }, "only touch the trailing prose");
	sh(["checkout", "-q", "main"]);
	expect(await conflictMarkerReason(repo, "feat")).toBeUndefined();
});

// A bare `=======` is genuinely ambiguous with a Markdown Setext H1 underline — must not false-positive
// on ordinary docs that never carry a real `<<<<<<< `/`>>>>>>> ` counterpart.
test("a lone '=======' with no start/end marker in the same file is NOT flagged (Markdown heading underline)", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "docs/compare.md": ["Compare", "=======", "", "ordinary setext-style heading, not a conflict.", ""].join("\n") }, "markdown heading");
	sh(["checkout", "-q", "main"]);
	expect(await conflictMarkerReason(repo, "feat")).toBeUndefined();
});

// But a lone '=======' IS flagged once its file also carries a real start/end marker — real conflict
// debris always comes as a triple, so requiring co-occurrence loses no real detection power.
test("a '=======' IS flagged once the same file also adds a start or end marker", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "docs/plan.md": ["<<<<<<< HEAD", "old", "=======", "new", ">>>>>>> feat", ""].join("\n") }, "full marker triple");
	sh(["checkout", "-q", "main"]);
	const r = await conflictMarkerReason(repo, "feat");
	expect(r).toBeDefined();
	expect(r).toContain("=======");
});

// Prose that merely MENTIONS marker characters mid-sentence (this very skill/doc's own claim) must
// never match — the regexes are anchored to the START of the line.
test("prose mentioning marker characters mid-line is not flagged", async () => {
	sh(["checkout", "-q", "-b", "feat"]);
	commitFiles({ "docs/skill.md": "The --verify gate must include a conflict-marker grep (e.g. grep -rn '^<<<<<<<' src/).\n" }, "doc describing the check");
	sh(["checkout", "-q", "main"]);
	expect(await conflictMarkerReason(repo, "feat")).toBeUndefined();
});

test("a bogus branch never throws — but is BLOCKED (fail-closed), not silently clean", async () => {
	const r = await conflictMarkerReason(repo, "does-not-exist");
	expect(r).toBeDefined();
	expect(r).toContain("conflict-markers gate:");
	expect(r).toContain("could not scan");
});

test("an unreadable repo never throws — but is BLOCKED (fail-closed), not silently clean", async () => {
	const r = await conflictMarkerReason("/no/such/repo", "feat");
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
