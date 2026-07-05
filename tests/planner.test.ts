/**
 * Planner core (src/planner.ts) — pure decode of the resident planner's LLM decompose
 * call: prompt assembly, tolerant JSON-array decode, structural validation, and dense
 * topological renumbering. No filesystem, no daemon, no real `omp` call (classify is
 * injected — mirrors intake.test.ts's routeIntake fixtures).
 */

import { expect, test } from "bun:test";
import { buildDecomposePrompt, decompose, parseConcernDrafts } from "../src/planner.ts";
import type { PlanConcern } from "../src/features.ts";

const CANNED_JSON = `Sure, here is the plan:
\`\`\`json
[
  {"num": 1, "slug": "core", "title": "Core module", "priority": "p1", "complexity": "architectural", "touches": ["src/core.ts"], "blockedBy": [], "goal": "Build the core.", "approach": "Write it.", "acceptance": ["core.ts exists"]},
  {"num": 2, "slug": "writer", "title": "Writer module", "priority": "p1", "complexity": "architectural", "touches": ["src/writer.ts"], "blockedBy": [1], "goal": "Build the writer.", "approach": "Write it.", "acceptance": ["writer.ts exists"]},
  {"num": 3, "slug": "wiring", "title": "Wire it up", "priority": "p2", "complexity": "mechanical", "touches": ["src/index.ts"], "blockedBy": [1, 2], "goal": "Wire the pieces.", "approach": "Import and call.", "acceptance": ["index.ts wires core+writer"]}
]
\`\`\`
Let me know if you want changes.`;

test("parseConcernDrafts: decodes a fenced JSON array with trailing prose into dense 1..N drafts", () => {
	const drafts = parseConcernDrafts(CANNED_JSON);
	expect(drafts).toBeDefined();
	expect(drafts!.map((d) => d.num)).toEqual([1, 2, 3]);
	expect(drafts!.map((d) => d.slug)).toEqual(["core", "writer", "wiring"]);
	const writer = drafts!.find((d) => d.slug === "writer")!;
	expect(writer.blockedBy).toEqual([1]); // in-batch sibling ref
	expect(writer.blockedByExternal).toEqual([]);
	const wiring = drafts!.find((d) => d.slug === "wiring")!;
	expect(wiring.blockedBy.sort()).toEqual([1, 2]);
	expect(wiring.blockedByExternal).toEqual([]);
});

test("parseConcernDrafts: renumbers out-of-order input into dependency-topological dense order", () => {
	const raw = JSON.stringify([
		{ num: 10, slug: "second", title: "Second", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [5], goal: "g", approach: "a", acceptance: ["x"] },
		{ num: 5, slug: "first", title: "First", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [], goal: "g", approach: "a", acceptance: ["x"] },
	]);
	const drafts = parseConcernDrafts(raw);
	expect(drafts).toBeDefined();
	const first = drafts!.find((d) => d.slug === "first")!;
	const second = drafts!.find((d) => d.slug === "second")!;
	expect(first.num).toBe(1);
	expect(second.num).toBe(2);
	expect(second.blockedBy).toEqual([1]); // remapped from the old num 5 → first's new num 1
});

test("parseConcernDrafts: malformed JSON returns undefined", () => {
	expect(parseConcernDrafts("not json at all")).toBeUndefined();
	expect(parseConcernDrafts("")).toBeUndefined();
});

test("parseConcernDrafts: a missing required field returns undefined", () => {
	const raw = JSON.stringify([{ num: 1, slug: "x", title: "X", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [], acceptance: ["y"] /* no goal */ }]);
	expect(parseConcernDrafts(raw)).toBeUndefined();
});

test("parseConcernDrafts: an invalid priority/complexity enum value returns undefined", () => {
	const raw = JSON.stringify([{ num: 1, slug: "x", title: "X", priority: "urgent", complexity: "mechanical", touches: [], blockedBy: [], goal: "g", approach: "a", acceptance: ["y"] }]);
	expect(parseConcernDrafts(raw)).toBeUndefined();
});

test("parseConcernDrafts: a self-referential blockedBy returns undefined", () => {
	const raw = JSON.stringify([{ num: 1, slug: "x", title: "X", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [1], goal: "g", approach: "a", acceptance: ["y"] }]);
	expect(parseConcernDrafts(raw)).toBeUndefined();
});

test("parseConcernDrafts: a multi-node cycle within the batch returns undefined", () => {
	const raw = JSON.stringify([
		{ num: 1, slug: "a", title: "A", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [2], goal: "g", approach: "a", acceptance: ["y"] },
		{ num: 2, slug: "b", title: "B", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [1], goal: "g", approach: "a", acceptance: ["y"] },
	]);
	expect(parseConcernDrafts(raw)).toBeUndefined();
});

test("parseConcernDrafts: an external blockedBy ref (outside the batch) is split into blockedByExternal, kept verbatim", () => {
	const raw = JSON.stringify([{ num: 1, slug: "x", title: "X", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [99], goal: "g", approach: "a", acceptance: ["y"] }]);
	const drafts = parseConcernDrafts(raw);
	expect(drafts).toBeDefined();
	expect(drafts![0].num).toBe(1);
	expect(drafts![0].blockedBy).toEqual([]); // no in-batch sibling refs
	expect(drafts![0].blockedByExternal).toEqual([99]); // external ref preserved verbatim
});

test("parseConcernDrafts: a mixed blocker list splits into in-batch (remapped) vs external (fixed)", () => {
	// Drafts #7 and #9; #9 blockedBy [7, 42] — 7 is an in-batch sibling (→ remaps), 42 is external.
	const raw = JSON.stringify([
		{ num: 7, slug: "a", title: "A", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [], goal: "g", approach: "a", acceptance: ["y"] },
		{ num: 9, slug: "b", title: "B", priority: "p1", complexity: "mechanical", touches: [], blockedBy: [7, 42], goal: "g", approach: "a", acceptance: ["y"] },
	]);
	const drafts = parseConcernDrafts(raw);
	expect(drafts).toBeDefined();
	const a = drafts!.find((d) => d.slug === "a")!;
	const b = drafts!.find((d) => d.slug === "b")!;
	expect(a.num).toBe(1);
	expect(b.num).toBe(2);
	expect(b.blockedBy).toEqual([1]); // in-batch ref 7 → A's new dense num 1
	expect(b.blockedByExternal).toEqual([42]); // external ref 42 untouched
});

test("buildDecomposePrompt: contains the objective, marks verified concerns do-not-re-emit, and demands a JSON array", () => {
	const existing: PlanConcern[] = [
		{ file: "01-foo.md", path: "plans/demo/01-foo.md", title: "Foo", status: "open", open: true, acceptanceCriteria: [], prerequisites: [], decisions: [], touches: [], content: "" },
	];
	const prompt = buildDecomposePrompt("Ship the resident planner", [{ num: 2, title: "Bar module", planeId: "OMPSQ-9" }], existing);
	expect(prompt).toContain("Ship the resident planner");
	expect(prompt).toContain("Bar module");
	expect(prompt).toMatch(/already complete.*do NOT re-emit/i);
	expect(prompt).toContain("Foo");
	expect(prompt.toLowerCase()).toContain("json array");
});

test("decompose: resolves the injected classify's JSON into parsed drafts", async () => {
	const drafts = await decompose({ objective: "obj", verified: [], existing: [], classify: async () => CANNED_JSON });
	expect(drafts.map((d) => d.slug)).toEqual(["core", "writer", "wiring"]);
});

test("decompose: a non-JSON classify answer resolves to [] rather than throwing", async () => {
	const drafts = await decompose({ objective: "obj", verified: [], existing: [], classify: async () => "not json" });
	expect(drafts).toEqual([]);
});

test("decompose: a throwing classify resolves to [] rather than throwing", async () => {
	const drafts = await decompose({
		objective: "obj",
		verified: [],
		existing: [],
		classify: async () => {
			throw new Error("boom");
		},
	});
	expect(drafts).toEqual([]);
});
