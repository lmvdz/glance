/**
 * `glance diff <id>` — the terminal review surface for `GET /api/agents/:id/diff`
 * (`worktreeDiffSinceFork`, explore.ts). These drive the two pure renderers directly
 * (`renderDiff`, `renderDiffStat`), matching how `renderAgentRoster`/`renderHarnessTable`
 * are tested in cli-list.test.ts/cli-harnesses.test.ts — no HTTP mocking anywhere in this
 * codebase's CLI tests, so this doesn't invent one.
 */
import { describe, expect, test } from "bun:test";
import { renderDiff, renderDiffStat } from "../src/index.ts";
import type { FileDiff } from "../src/explore.ts";

const modified: FileDiff = {
	file: "src/foo.ts",
	status: "M ",
	diff: ["--- a/src/foo.ts", "+++ b/src/foo.ts", "@@ -1,3 +1,3 @@", " context line", "-old line", "+new line"].join("\n"),
};

const added: FileDiff = {
	file: "src/bar.ts",
	status: "A ",
	diff: ["--- /dev/null", "+++ b/src/bar.ts", "@@ -0,0 +1,2 @@", "+line one", "+line two"].join("\n"),
};

const untracked: FileDiff = {
	file: "notes.txt",
	status: "??",
	diff: ["--- /dev/null", "+++ b/notes.txt", "@@ -0,0 +1,1 @@", "+hello"].join("\n"),
};

describe("renderDiff", () => {
	test("no files renders a clean 'no changes'", () => {
		expect(renderDiff([])).toBe("no changes\n");
	});

	test("plain (uncolored) output preserves every diff line verbatim, with a human status label", () => {
		const out = renderDiff([modified]);
		expect(out).toContain("modified  src/foo.ts");
		expect(out).toContain("--- a/src/foo.ts");
		expect(out).toContain("+++ b/src/foo.ts");
		expect(out).toContain("@@ -1,3 +1,3 @@");
		expect(out).toContain("-old line");
		expect(out).toContain("+new line");
		expect(out).toContain(" context line");
		// no ANSI escapes leaked when color is off (the default)
		expect(out).not.toContain("\x1b[");
	});

	test("untracked ('??') status renders as 'untracked', added ('A ') as 'added'", () => {
		expect(renderDiff([untracked])).toContain("untracked  notes.txt");
		expect(renderDiff([added])).toContain("added  src/bar.ts");
	});

	test("color mode wraps +/-/@@/header lines in the expected ANSI codes, context lines stay plain", () => {
		const out = renderDiff([modified], { color: true });
		expect(out).toContain("\x1b[91m-old line\x1b[0m"); // red removal
		expect(out).toContain("\x1b[92m+new line\x1b[0m"); // green addition
		expect(out).toContain("\x1b[96m@@ -1,3 +1,3 @@\x1b[0m"); // cyan hunk header
		expect(out).toContain("\x1b[2m--- a/src/foo.ts\x1b[0m"); // dim file header
		expect(out).toContain("\x1b[1mmodified  src/foo.ts\x1b[0m"); // bold status line
		expect(out).toContain(" context line"); // context line untouched
	});

	test("multiple files each get their own status header, in order", () => {
		const out = renderDiff([modified, added]);
		const modIdx = out.indexOf("modified  src/foo.ts");
		const addIdx = out.indexOf("added  src/bar.ts");
		expect(modIdx).toBeGreaterThanOrEqual(0);
		expect(addIdx).toBeGreaterThan(modIdx);
	});

	test("an empty diff body (binary / pure rename) is called out instead of rendering nothing", () => {
		const out = renderDiff([{ file: "img.png", status: "M ", diff: "" }]);
		expect(out).toContain("modified  img.png");
		expect(out).toContain("no diff body");
	});
});

describe("renderDiffStat", () => {
	test("no files renders a clean 'no changes'", () => {
		expect(renderDiffStat([])).toBe("no changes\n");
	});

	test("counts +/- lines per file, excluding the +++/--- file headers, and totals across files", () => {
		const out = renderDiffStat([modified, added]);
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("modified");
		expect(out).toContain("+1 -1"); // one added, one removed line in `modified`'s hunk
		expect(out).toContain("src/bar.ts");
		expect(out).toContain("added");
		expect(out).toContain("+2 -0"); // two added lines in `added`'s hunk
		expect(out).toContain("2 files changed, +3 -1");
	});

	test("a single file uses the singular 'file changed'", () => {
		expect(renderDiffStat([modified])).toContain("1 file changed, +1 -1");
	});

	test("--stat never leaks a diff body line", () => {
		const out = renderDiffStat([modified]);
		expect(out).not.toContain("-old line");
		expect(out).not.toContain("+new line");
	});
});
