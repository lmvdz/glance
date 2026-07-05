/**
 * Plan-doc writer (src/plan-writer.ts) — materializes ConcernDraft[] into plans/<x>/NN-slug.md
 * + 00-overview.md idempotently, behind the shared DAG gate (validatePlanConcerns). Exercises
 * the write→validate→rollback discipline and the one-directional terminal-STATUS preservation.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeConcernDrafts } from "../src/plan-writer.ts";
import { parsePlanConcerns, validatePlanConcerns } from "../src/features.ts";
import type { ConcernDraft } from "../src/planner.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function scratchRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-writer-"));
	tmps.push(repo);
	return repo;
}

function draft(partial: Partial<ConcernDraft> & Pick<ConcernDraft, "num" | "slug" | "title">): ConcernDraft {
	return {
		priority: "p1",
		complexity: "mechanical",
		touches: ["src/example.ts"],
		blockedBy: [], // in-batch sibling refs (follow renumbering)
		blockedByExternal: [], // refs to already-resident concerns (fixed)
		goal: "Do the thing.",
		approach: "Just do it.",
		acceptance: ["it is done"],
		...partial,
	};
}

async function readDirFiles(dirAbs: string): Promise<Map<string, string>> {
	const files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
	const out = new Map<string, string>();
	for (const f of files) out.set(f, await fs.readFile(path.join(dirAbs, f), "utf8"));
	return out;
}

test("writeConcernDrafts: writes a 3-draft set to a clean plan dir and passes the DAG gate", async () => {
	const repo = await scratchRepo();
	const drafts: ConcernDraft[] = [
		draft({ num: 1, slug: "core", title: "Core module" }),
		draft({ num: 2, slug: "writer", title: "Writer module", blockedBy: [1] }),
		draft({ num: 3, slug: "wiring", title: "Wire it up", blockedBy: [1, 2] }),
	];
	const result = await writeConcernDrafts(repo, "plans/demo", drafts);
	expect(result.ok).toBe(true);
	expect(result.issues).toEqual([]);

	const dirAbs = path.join(repo, "plans", "demo");
	const files = (await fs.readdir(dirAbs)).sort();
	expect(files).toEqual(["00-overview.md", "01-core.md", "02-writer.md", "03-wiring.md"]);

	const concerns = await parsePlanConcerns(repo, "plans/demo");
	expect(concerns).toHaveLength(3);
	const core = concerns.find((c) => c.file === "01-core.md")!;
	expect(core.title).toBe("Core module");
	expect(core.priority).toBe("p1");
	expect(core.complexity).toBe("mechanical");
	expect(core.touches).toEqual(["src/example.ts"]);
	expect(core.status).toBe("open");

	expect(await validatePlanConcerns(repo, "plans/demo")).toEqual([]);
	expect((await fs.readFile(path.join(dirAbs, "00-overview.md"), "utf8"))).toContain("## Dependency graph");
});

test("writeConcernDrafts: a second identical write is a no-op (idempotent, byte-identical)", async () => {
	const repo = await scratchRepo();
	const drafts: ConcernDraft[] = [draft({ num: 1, slug: "core", title: "Core module" }), draft({ num: 2, slug: "writer", title: "Writer module", blockedBy: [1] })];
	const first = await writeConcernDrafts(repo, "plans/demo", drafts);
	expect(first.ok).toBe(true);
	const dirAbs = path.join(repo, "plans", "demo");
	const before = await readDirFiles(dirAbs);

	const second = await writeConcernDrafts(repo, "plans/demo", drafts);
	expect(second.ok).toBe(true);
	expect(second.written).toEqual([]);
	expect(second.removed).toEqual([]);
	const after = await readDirFiles(dirAbs);
	expect(after).toEqual(before);
});

test("writeConcernDrafts: a dangling blockedBy is refused and the plan dir rolls back to its pre-write state", async () => {
	const repo = await scratchRepo();
	const clean: ConcernDraft[] = [draft({ num: 1, slug: "core", title: "Core module" })];
	const first = await writeConcernDrafts(repo, "plans/demo", clean);
	expect(first.ok).toBe(true);
	const dirAbs = path.join(repo, "plans", "demo");
	const snapshot = await readDirFiles(dirAbs);

	const broken: ConcernDraft[] = [draft({ num: 1, slug: "core", title: "Core module" }), draft({ num: 2, slug: "dangling", title: "Dangling dep", blockedBy: [999] })];
	const second = await writeConcernDrafts(repo, "plans/demo", broken);
	expect(second.ok).toBe(false);
	expect(second.issues.length).toBeGreaterThan(0);
	expect(second.issues[0].kind).toBe("unresolved");

	const after = await readDirFiles(dirAbs);
	expect(after).toEqual(snapshot); // rolled back exactly — no dangling concern survives on disk
});

test("writeConcernDrafts: preserves a terminal concern's STATUS and file, and prunes a dropped open orphan", async () => {
	const repo = await scratchRepo();
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.mkdir(dirAbs, { recursive: true });
	await fs.writeFile(path.join(dirAbs, "02-foo.md"), "# Foo\n\nSTATUS: done\nPRIORITY: p1\nCOMPLEXITY: mechanical\nTOUCHES: src/foo.ts\n\n## Goal\n\nDone already.\n\n## Approach\n\nn/a\n\n## Acceptance Criteria\n\n- shipped\n");
	await fs.writeFile(path.join(dirAbs, "03-bar.md"), "# Bar\n\nSTATUS: open\nPRIORITY: p2\nCOMPLEXITY: mechanical\nTOUCHES: src/bar.ts\n\n## Goal\n\nStill open.\n\n## Approach\n\nn/a\n\n## Acceptance Criteria\n\n- works\n");

	// New draft set omits both concern 2 (terminal, must survive) and concern 3 (open orphan, must be pruned).
	const drafts: ConcernDraft[] = [draft({ num: 1, slug: "core", title: "Core module" })];
	const result = await writeConcernDrafts(repo, "plans/demo", drafts);
	expect(result.ok).toBe(true);

	const fooContent = await fs.readFile(path.join(dirAbs, "02-foo.md"), "utf8");
	expect(fooContent).toContain("STATUS: done");

	const files = (await fs.readdir(dirAbs)).sort();
	expect(files).toEqual(["00-overview.md", "01-core.md", "02-foo.md"]); // 03-bar.md pruned
	expect(result.removed).toContain("03-bar.md");
});

test("writeConcernDrafts: protectedNums shields a still-open-on-disk concern from pruning (the loop's DoneProof-verified case)", async () => {
	const repo = await scratchRepo();
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.mkdir(dirAbs, { recursive: true });
	// STATUS is still "open" on disk (plan-sync hasn't caught up), but the loop knows via DoneProof
	// that concern 1 is verified-done and must not be pruned even though the new drafts omit it.
	await fs.writeFile(path.join(dirAbs, "01-core.md"), "# Core module\n\nSTATUS: open\nPRIORITY: p1\nCOMPLEXITY: architectural\nTOUCHES: src/core.ts\nPLANE: DEMO-1\n\n## Goal\n\nBuild it.\n\n## Approach\n\nWrite it.\n\n## Acceptance Criteria\n\n- core.ts exists\n");

	const drafts: ConcernDraft[] = [draft({ num: 2, slug: "wiring", title: "Wire it up" })];
	const result = await writeConcernDrafts(repo, "plans/demo", drafts, { protectedNums: [1] });
	expect(result.ok).toBe(true);

	const files = (await fs.readdir(dirAbs)).sort();
	expect(files).toEqual(["00-overview.md", "01-core.md", "02-wiring.md"]); // core survives, NOT pruned
	const coreContent = await fs.readFile(path.join(dirAbs, "01-core.md"), "utf8");
	expect(coreContent).toContain("PLANE: DEMO-1");
	expect(coreContent).toContain("STATUS: open");
	expect(await validatePlanConcerns(repo, "plans/demo")).toEqual([]);
});

test("writeConcernDrafts: a solo draft that collides with a reserved number keeps its EXTERNAL blocker fixed (no self-loop)", async () => {
	// A single-item batch dense-renumbers to num=1; it carries a genuine EXTERNAL dependency on the
	// reserved/terminal concern also numbered 1. The draft's own num-1 collision is remapped to 2, but
	// its blockedByExternal=[1] must stay pointing at the frozen concern (never remapped along with the
	// draft, which would manufacture a self-loop and get the whole write discarded at the DAG gate).
	const repo = await scratchRepo();
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.mkdir(dirAbs, { recursive: true });
	await fs.writeFile(path.join(dirAbs, "01-subcommand.md"), "# Add hello subcommand\n\nSTATUS: done\nPRIORITY: p0\nCOMPLEXITY: mechanical\nTOUCHES: src/cli.ts\n\n## Goal\n\nDone.\n\n## Approach\n\nn/a\n\n## Acceptance Criteria\n\n- shipped\n");

	const solo: ConcernDraft = draft({ num: 1, slug: "test-subcommand", title: "Add unit test for hello subcommand", blockedByExternal: [1] });
	const result = await writeConcernDrafts(repo, "plans/demo", [solo], { protectedNums: [1] });

	expect(result.ok).toBe(true);
	expect(result.issues).toEqual([]);
	const files = (await fs.readdir(dirAbs)).sort();
	expect(files).toEqual(["00-overview.md", "01-subcommand.md", "02-test-subcommand.md"]);
	const overview = await fs.readFile(path.join(dirAbs, "00-overview.md"), "utf8");
	expect(overview).toContain("| 2 Add unit test for hello subcommand | 1 |"); // external blocker stayed 1
	expect(await validatePlanConcerns(repo, "plans/demo")).toEqual([]);
});

test("writeConcernDrafts: SIG-1 — an IN-BATCH dependency on a number a terminal concern also owns follows the remap, not the terminal (real edge kept, false edge not manufactured)", async () => {
	// The coordinator's exact repro. Disk has terminal concern #2. The draft batch (dense 1..3) is
	// First#1, Middle#2 (blocked by First), Last#3 (blocked by Middle — an IN-BATCH edge on #2). #2 is
	// reserved (terminal), so Middle remaps 2→4. Last's dependency on Middle must follow to 4 — the old
	// buggy heuristic ("blockedBy value == a reserved number ⇒ external") kept it at 2, silently losing
	// the real Last←Middle edge and manufacturing a false Last←(done #2) edge that validatePlanConcerns
	// can't catch because it resolves to a real (done) concern, so Last would dispatch before Middle.
	const repo = await scratchRepo();
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.mkdir(dirAbs, { recursive: true });
	await fs.writeFile(path.join(dirAbs, "02-middle-done.md"), "# Already-done middle\n\nSTATUS: done\nPRIORITY: p1\nCOMPLEXITY: mechanical\nTOUCHES: src/done.ts\n\n## Goal\n\nDone.\n\n## Approach\n\nn/a\n\n## Acceptance Criteria\n\n- shipped\n");

	const drafts: ConcernDraft[] = [
		draft({ num: 1, slug: "first", title: "First" }),
		draft({ num: 2, slug: "middle", title: "Middle", blockedBy: [1] }), // in-batch: Middle ← First
		draft({ num: 3, slug: "last", title: "Last", blockedBy: [2] }), // in-batch: Last ← Middle(#2)
	];
	const result = await writeConcernDrafts(repo, "plans/demo", drafts);
	expect(result.ok).toBe(true);
	expect(result.issues).toEqual([]);

	// Terminal #2 preserved untouched; Middle remapped to the first free slot (4); Last still at 3.
	const files = (await fs.readdir(dirAbs)).sort();
	expect(files).toEqual(["00-overview.md", "01-first.md", "02-middle-done.md", "03-last.md", "04-middle.md"]);

	const overview = await fs.readFile(path.join(dirAbs, "00-overview.md"), "utf8");
	expect(overview).toContain("| 3 Last | 4 |"); // Last blocked by Middle's NEW number 4 — the real edge
	expect(overview).not.toMatch(/\|\s*3 Last\s*\|\s*2\s*\|/); // NOT the false edge onto the done concern
	expect(overview).toContain("| 4 Middle | 1 |"); // Middle still blocked by First
	expect(await validatePlanConcerns(repo, "plans/demo")).toEqual([]);
});

test("writeConcernDrafts: refining an already-filed open concern preserves its PLANE: pointer", async () => {
	const repo = await scratchRepo();
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.mkdir(dirAbs, { recursive: true });
	await fs.writeFile(path.join(dirAbs, "01-existing.md"), "# Existing concern\n\nSTATUS: open\nPRIORITY: p2\nCOMPLEXITY: mechanical\nTOUCHES: src/old.ts\nPLANE: DEMO-1\n\n## Goal\n\nold goal\n\n## Approach\n\nold approach\n\n## Acceptance Criteria\n\n- old\n");

	const result = await writeConcernDrafts(repo, "plans/demo", [draft({ num: 1, slug: "existing", title: "Existing concern (refined)" })]);
	expect(result.ok).toBe(true);
	const content = await fs.readFile(path.join(dirAbs, "01-existing.md"), "utf8");
	expect(content).toContain("PLANE: DEMO-1");
	expect(content).toContain("# Existing concern (refined)");
	expect(content).toContain("STATUS: open");

	const concerns = await parsePlanConcerns(repo, "plans/demo");
	expect(concerns[0].planeId).toBe("DEMO-1");
});

test("writeConcernDrafts: never touches OBJECTIVE.md or DESIGN.md", async () => {
	const repo = await scratchRepo();
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.mkdir(dirAbs, { recursive: true });
	await fs.writeFile(path.join(dirAbs, "OBJECTIVE.md"), "Ship the resident planner.\n");
	await fs.writeFile(path.join(dirAbs, "DESIGN.md"), "# Design\n\nSome locked decisions.\n");

	await writeConcernDrafts(repo, "plans/demo", [draft({ num: 1, slug: "core", title: "Core module" })]);

	expect(await fs.readFile(path.join(dirAbs, "OBJECTIVE.md"), "utf8")).toBe("Ship the resident planner.\n");
	expect(await fs.readFile(path.join(dirAbs, "DESIGN.md"), "utf8")).toBe("# Design\n\nSome locked decisions.\n");
});
