/**
 * ResidentPlanner (src/resident-planner.ts) — the standing loop that decomposes a
 * plans/<name>/OBJECTIVE.md into a concern-DAG, gated by OMP_SQUAD_RESIDENT_PLANNER
 * (default OFF — setup.ts strips OMP_SQUAD_* before every test, so it's unset unless a
 * test sets it itself). Hermetic: classify and hasProof are injected, no real `omp` call.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ResidentPlanner, residentPlannerEnabled } from "../src/resident-planner.ts";
import { parsePlanConcerns, validatePlanConcerns } from "../src/features.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
afterEach(() => {
	delete process.env.OMP_SQUAD_RESIDENT_PLANNER;
});

async function scratchRepo(): Promise<{ repo: string; stateDir: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "resident-planner-repo-"));
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "resident-planner-state-"));
	tmps.push(repo, stateDir);
	await fs.mkdir(path.join(repo, "plans", "demo"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "demo", "OBJECTIVE.md"), "Ship the resident planner end to end.\n");
	return { repo, stateDir };
}

const DRAFT_JSON = JSON.stringify([
	{ num: 1, slug: "core", title: "Core module", priority: "p1", complexity: "architectural", touches: ["src/core.ts"], blockedBy: [], goal: "Build it.", approach: "Write it.", acceptance: ["core.ts exists"] },
	{ num: 2, slug: "wiring", title: "Wire it up", priority: "p2", complexity: "mechanical", touches: ["src/index.ts"], blockedBy: [1], goal: "Wire it.", approach: "Import it.", acceptance: ["wired"] },
]);

test("residentPlannerEnabled: reads OMP_SQUAD_RESIDENT_PLANNER === '1' (opt-in, unlike the other loops)", () => {
	delete process.env.OMP_SQUAD_RESIDENT_PLANNER;
	expect(residentPlannerEnabled()).toBe(false);
	process.env.OMP_SQUAD_RESIDENT_PLANNER = "1";
	expect(residentPlannerEnabled()).toBe(true);
});

test("tick(): first pass decomposes an OBJECTIVE.md into a valid concern tree and fires onChanged once", async () => {
	process.env.OMP_SQUAD_RESIDENT_PLANNER = "1";
	const { repo, stateDir } = await scratchRepo();
	let classifyCalls = 0;
	let changed = 0;
	const planner = new ResidentPlanner({
		repo,
		stateDir,
		classify: async () => {
			classifyCalls++;
			return DRAFT_JSON;
		},
		hasProof: () => false,
		onChanged: () => changed++,
	});

	await planner.tick();

	expect(classifyCalls).toBe(1);
	expect(changed).toBe(1);
	const issues = await validatePlanConcerns(repo, "plans/demo");
	expect(issues).toEqual([]);
	const files = (await fs.readdir(path.join(repo, "plans", "demo"))).sort();
	expect(files).toEqual(["00-overview.md", "01-core.md", "02-wiring.md", "OBJECTIVE.md"]);
});

test("tick(): a second pass with unchanged inputs is a hash-skip — no LLM call, no file changes, already-handled heartbeat", async () => {
	process.env.OMP_SQUAD_RESIDENT_PLANNER = "1";
	const { repo, stateDir } = await scratchRepo();
	let classifyCalls = 0;
	const events: { skipReason?: string; found?: number; filed?: number }[] = [];
	const planner = new ResidentPlanner({
		repo,
		stateDir,
		classify: async () => {
			classifyCalls++;
			return DRAFT_JSON;
		},
		hasProof: () => false,
		record: (r) => events.push(r),
	});

	await planner.tick();
	expect(classifyCalls).toBe(1);
	const before = await fs.readFile(path.join(repo, "plans", "demo", "01-core.md"), "utf8");

	await planner.tick();
	expect(classifyCalls).toBe(1); // NOT called again — hash-skip
	const after = await fs.readFile(path.join(repo, "plans", "demo", "01-core.md"), "utf8");
	expect(after).toBe(before);
	expect(events.at(-1)?.skipReason).toBe("already-handled");
});

test("tick(): flipping hasProof re-triggers decompose, passes the concern as verified in the prompt, and the re-emitted tree collapses it without colliding with its (still-open-on-disk) number", async () => {
	process.env.OMP_SQUAD_RESIDENT_PLANNER = "1";
	const { repo, stateDir } = await scratchRepo();
	// Pre-seed the plan as if tick 1 already ran: concern 1 (core, filed to Plane) and concern 2
	// (wiring, blocked on core), both still STATUS: open on disk — plan-sync (a separate, slower
	// loop) is what eventually flips STATUS; this loop reacts to DoneProof before that happens.
	const dirAbs = path.join(repo, "plans", "demo");
	await fs.writeFile(path.join(dirAbs, "01-core.md"), "# Core module\n\nSTATUS: open\nPRIORITY: p1\nCOMPLEXITY: architectural\nTOUCHES: src/core.ts\nPLANE: DEMO-1\n\n## Goal\n\nBuild it.\n\n## Approach\n\nWrite it.\n\n## Acceptance Criteria\n\n- core.ts exists\n");
	await fs.writeFile(path.join(dirAbs, "02-wiring.md"), "# Wire it up\n\nSTATUS: open\nPRIORITY: p2\nCOMPLEXITY: mechanical\nTOUCHES: src/index.ts\n\n## Goal\n\nWire it.\n\n## Approach\n\nImport it.\n\n## Acceptance Criteria\n\n- wired\n");

	let verifiedId: string | null = null;
	const prompts: string[] = [];
	let classifyCalls = 0;
	const planner = new ResidentPlanner({
		repo,
		stateDir,
		classify: async (prompt) => {
			classifyCalls++;
			prompts.push(prompt);
			if (verifiedId === "DEMO-1") {
				// Core is verified-done — the model plans ONLY the remaining frontier (wiring alone),
				// densely renumbered to 1 by parseConcernDrafts. This is the exact case that would
				// collide with core's still-resident (open-on-disk) num=1 without reservation.
				return JSON.stringify([{ num: 1, slug: "wiring", title: "Wire it up", priority: "p2", complexity: "mechanical", touches: ["src/index.ts"], blockedBy: [], goal: "Wire it.", approach: "Import it.", acceptance: ["wired"] }]);
			}
			// Nothing verified yet — the model re-emits the full open frontier (core refined + wiring).
			return DRAFT_JSON;
		},
		hasProof: (id) => id === verifiedId,
	});

	await planner.tick();
	expect(classifyCalls).toBe(1);

	verifiedId = "DEMO-1";
	await planner.tick();
	expect(classifyCalls).toBe(2); // verified state changed ⇒ re-triggered, not hash-skipped
	expect(prompts[1]).toContain("DEMO-1");
	expect(prompts[1]).toMatch(/already complete.*do NOT re-emit/i);

	// Core's file (and its PLANE: pointer) must survive untouched — the model correctly omitted it,
	// and the loop must never let a colliding renumbered draft destroy it.
	const coreContent = await fs.readFile(path.join(dirAbs, "01-core.md"), "utf8");
	expect(coreContent).toContain("PLANE: DEMO-1");
	expect(coreContent).toContain("# Core module");

	// The dependency graph stays clean (no dangling/duplicate refs introduced by the reconciliation).
	expect(await validatePlanConcerns(repo, "plans/demo")).toEqual([]);
	const concerns = await parsePlanConcerns(repo, "plans/demo");
	expect(concerns.map((c) => c.title).sort()).toEqual(["Core module", "Wire it up"]);
});

test("start()/tick(): with OMP_SQUAD_RESIDENT_PLANNER unset, start() installs no timer and tick() is a no-op", async () => {
	delete process.env.OMP_SQUAD_RESIDENT_PLANNER;
	const { repo, stateDir } = await scratchRepo();
	let classifyCalls = 0;
	const planner = new ResidentPlanner({
		repo,
		stateDir,
		classify: async () => {
			classifyCalls++;
			return DRAFT_JSON;
		},
		hasProof: () => false,
	});

	planner.start(50);
	await planner.tick();
	expect(classifyCalls).toBe(0);
	const files = await fs.readdir(path.join(repo, "plans", "demo"));
	expect(files).toEqual(["OBJECTIVE.md"]); // untouched
	planner.stop();
});
