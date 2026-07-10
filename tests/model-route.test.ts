import { describe, expect, test } from "bun:test";
import { ROUTE_CHEAP_FAMILY, ROUTE_FRONTIER_FAMILY, ROUTE_FRONTIER_MODEL, routeModelForTaskClass } from "../src/model-route.ts";
import { buildTaskClassMatrix, MIN_SAMPLES, type DenominatorUnit } from "../src/omp-graph/task-class-matrix.ts";
import { MIN_EDGE } from "../src/smart-spawn.ts";
import { HOUR_MS } from "../src/omp-graph/schema.ts";
import type { TaskOutcomeRow } from "../src/task-outcomes.ts";

const range = { start: 0, end: 24 * HOUR_MS };
const taskClass = { mode: "tdd", tier: "heavy" };

const row = (over: Partial<TaskOutcomeRow>): TaskOutcomeRow => ({
	agentId: "a",
	routing: taskClass,
	outcome: "landed",
	source: "land",
	ts: HOUR_MS,
	...over,
});

const unit = (over: Partial<DenominatorUnit>): DenominatorUnit => ({
	agentId: "a",
	taskClass,
	...over,
});

/** Build a cell with `n` denominator members, `landedCount` of which land, all tagged with `model`
 *  (a raw model string that `modelFamily` folds to the matrix's family key). Every row carries a
 *  `costUsd` so `costCoveragePct` clears `MIN_COVERAGE_PCT` — the `reproducible` gate (eap-borrows
 *  concern 01) `routeModelForTaskClass` now honors alongside `insufficientData`. */
function seedCell(model: string, n: number, landedCount: number): { denom: DenominatorUnit[]; rows: TaskOutcomeRow[] } {
	const denom: DenominatorUnit[] = [];
	const rows: TaskOutcomeRow[] = [];
	for (let i = 0; i < n; i++) {
		const agentId = `${model}-${i}`;
		denom.push(unit({ agentId }));
		rows.push(row({ agentId, model, costUsd: 1, outcome: i < landedCount ? "landed" : "rejected" }));
	}
	return { denom, rows };
}

describe("routeModelForTaskClass", () => {
	test("insufficient-data cell (either side) ⇒ no shift", () => {
		// Cheap side has only 1 sample (below MIN_SAMPLES=3); frontier is well-populated and clearly better.
		const cheap = seedCell("claude-sonnet-5", 1, 0);
		const frontier = seedCell("claude-opus-4-8", 5, 5);
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		expect(doc.cells["tdd:heavy"][ROUTE_CHEAP_FAMILY].insufficientData).toBe(true);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBeUndefined();
		expect(decision.reason).toContain("no-shift");
		expect(decision.reason).toContain("insufficient data");
	});

	test("frontier side thin ⇒ no shift, even if its handful of samples all landed", () => {
		const cheap = seedCell("claude-sonnet-5", 6, 1); // well-measured, poor rate
		const frontier = seedCell("claude-opus-4-8", 2, 2); // below MIN_SAMPLES — a lucky streak, not evidence
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBeUndefined();
		expect(decision.reason).toContain("frontier");
	});

	test("cheap model clearly underperforms the frontier (above edge + samples) ⇒ shift to frontier", () => {
		const cheap = seedCell("claude-sonnet-5", 10, 2); // 0.2 land-rate
		const frontier = seedCell("claude-opus-4-8", 10, 9); // 0.9 land-rate — edge 0.7 >> MIN_EDGE
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		expect(doc.cells["tdd:heavy"][ROUTE_CHEAP_FAMILY].mergeRate).toBeCloseTo(0.2, 5);
		expect(doc.cells["tdd:heavy"][ROUTE_FRONTIER_FAMILY].mergeRate).toBeCloseTo(0.9, 5);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBe(ROUTE_FRONTIER_MODEL);
		expect(decision.reason).toContain("tdd:heavy");
	});

	test("cheap model performs fine (edge under the floor) ⇒ stay cheap", () => {
		const cheap = seedCell("claude-sonnet-5", 10, 8); // 0.8 land-rate
		const frontier = seedCell("claude-opus-4-8", 10, 9); // 0.9 land-rate — edge 0.1 < MIN_EDGE (0.15)
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBeUndefined();
		expect(decision.reason).toContain("edge");
	});

	test("edge exactly at MIN_EDGE still shifts (>= floor, not > floor)", () => {
		// 10 samples: cheap 5/10 = 0.5, frontier 6.5/10 isn't integral — use 20 samples for exact 0.15 edge.
		const cheap = seedCell("claude-sonnet-5", 20, 10); // 0.50
		const frontier = seedCell("claude-opus-4-8", 20, 13); // 0.65 — edge exactly 0.15
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		const edge = doc.cells["tdd:heavy"][ROUTE_FRONTIER_FAMILY].mergeRate - doc.cells["tdd:heavy"][ROUTE_CHEAP_FAMILY].mergeRate;
		expect(edge).toBeCloseTo(MIN_EDGE, 5);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBe(ROUTE_FRONTIER_MODEL);
	});

	test("empty matrix ⇒ no shift", () => {
		const doc = buildTaskClassMatrix([], [], range);
		expect(Object.keys(doc.cells).length).toBe(0);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBeUndefined();
		expect(decision.reason).toContain("no cell");
	});

	test("no cell for a DIFFERENT taskClass than the one seeded ⇒ no shift", () => {
		const cheap = seedCell("claude-sonnet-5", 10, 1);
		const frontier = seedCell("claude-opus-4-8", 10, 9);
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		const decision = routeModelForTaskClass({ mode: "none", tier: "light" }, doc);
		expect(decision.model).toBeUndefined();
		expect(decision.reason).toContain("no cell");
	});

	test("MIN_SAMPLES is respected via the matrix's own insufficientData flag, not re-derived", () => {
		// Sanity check the fixture matches the matrix's real gate so the "insufficient" tests above are
		// exercising the intended boundary, not an accidental one.
		expect(MIN_SAMPLES).toBe(3);
	});
});
