/**
 * `readPlan` — the shared structural read behind both `scripts/render-plan.ts`'s HTML and its
 * `--json` mode (the input `/distill-plan` consumes). One parser, one status/blocker/actionable
 * rule: a distillation pass that re-derived these by hand would drift from what the renderer draws,
 * and the two views of the same plan would disagree in front of a human.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConcern, readPlan } from "../scripts/render-plan.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function planDir(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readplan-"));
	cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }));
	for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
	return dir;
}

test("parseConcern splits frontmatter fields from ## sections", () => {
	const c = parseConcern("01-thing.md", "# The thing\nSTATUS: open\nPRIORITY: p1\nBLOCKED_BY: 02\n\n## Goal\nDo the thing.\n\n## Verify\nIt is done.\n");
	expect(c.num).toBe("01");
	expect(c.title).toBe("The thing");
	expect(c.fields.STATUS).toBe("open");
	expect(c.fields.BLOCKED_BY).toBe("02");
	expect(c.sections.Goal).toBe("Do the thing.");
	expect(c.sections.Verify).toBe("It is done.");
});

test("actionable = open AND every blocker done; blockedBy lists only the unmet ones", async () => {
	const dir = await planDir({
		"00-overview.md": "# Overview\n\n## Outcome\nA thing gets built.\n",
		"01-first.md": "# First\nSTATUS: done\n\n## Goal\nFoundation.\n",
		"02-second.md": "# Second\nSTATUS: open\nBLOCKED_BY: 01\n\n## Goal\nBuilds on the foundation.\n",
		"03-third.md": "# Third\nSTATUS: open\nBLOCKED_BY: 02\n\n## Goal\nBuilds on the second.\n",
		"04-parked.md": "# Fourth\nSTATUS: parked\n\n## Goal\nNot now.\n",
	});
	const s = await readPlan(dir);

	expect(s.total).toBe(4); // the 00 overview is not a concern
	expect(s.done).toBe(1);
	expect(s.overview?.sections.Outcome).toContain("A thing gets built");
	expect(s.actionable.map((c) => c.num)).toEqual(["02"]); // 03's blocker is still open; 04 is not open
	expect(s.blockedBy["02"]).toEqual([]); // 01 is done — no unmet blockers
	expect(s.blockedBy["03"]).toEqual(["02"]);
});

test("a plan with nothing done has no actionable-by-default illusion", async () => {
	const dir = await planDir({
		"01-a.md": "# A\nSTATUS: open\nBLOCKED_BY: 02\n\n## Goal\nx.\n",
		"02-b.md": "# B\nSTATUS: open\nBLOCKED_BY: 01\n\n## Goal\ny.\n", // deliberate cycle
	});
	const s = await readPlan(dir);
	expect(s.done).toBe(0);
	expect(s.actionable).toHaveLength(0); // a cycle yields nothing actionable rather than everything
});

test("unnumbered docs are ignored; concern order is numeric", async () => {
	const dir = await planDir({
		"DESIGN.md": "# Design\n\n## Outcome\nnot a concern\n",
		"RECONCILE.md": "# Reconcile\n",
		"10-ten.md": "# Ten\nSTATUS: open\n\n## Goal\nz.\n",
		"02-two.md": "# Two\nSTATUS: open\n\n## Goal\nz.\n",
	});
	const s = await readPlan(dir);
	expect(s.items.map((c) => c.num)).toEqual(["02", "10"]);
});
