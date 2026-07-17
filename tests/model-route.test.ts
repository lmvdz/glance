import { afterEach, describe, expect, test } from "bun:test";
import { LANE_POLICY } from "../src/lane.ts";
import { modelRouteMinEdgeFor, modelRouteShouldApply, ROUTE_CHEAP_FAMILY, ROUTE_FRONTIER_FAMILY, ROUTE_FRONTIER_MODEL, routeModelForTaskClass } from "../src/model-route.ts";
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

	// ── Code-review finding #7: the `reproducible` gate permanently disabled the live router ────────

	test("a SATURATED (1.0) frontier champion still shifts — the champion-self-exclusion fix", () => {
		// Before the fix: the frontier cell IS its taskClass's auto-champion (best mergeRate), and
		// `reproducible` compared its variance against ITSELF — `hasVarianceBetween(x, x)` is false at a
		// saturated mergeRate, so a perfect-record champion was never `reproducible` and the router
		// returned `noShift()` on every dispatch for any taskClass whose best model ever landed 100%.
		const cheap = seedCell("claude-sonnet-5", 10, 5); // 0.5 — well-measured, not saturated
		const frontier = seedCell("claude-opus-4-8", 10, 10); // 1.0 — saturated champion
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		expect(doc.champions["tdd:heavy"]).toBe(ROUTE_FRONTIER_FAMILY);
		expect(doc.cells["tdd:heavy"][ROUTE_FRONTIER_FAMILY].reproducible).toBe(true);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBe(ROUTE_FRONTIER_MODEL);
	});

	test("a null-cost fleet (no row carries costUsd) still shifts on mergeRate evidence alone", () => {
		// Before the fix: `isSampleSufficient` folded a `costCoveragePct >= 0.5` floor into champion
		// selection — on a fleet whose outcome rows mostly lack `costUsd` (true of this fleet
		// historically), NO cell was ever sample-sufficient, no champion ever existed, and routing was
		// dead fleet-wide with a "not reproducible" reason that actually meant "missing cost data".
		const denomC: DenominatorUnit[] = [];
		const rowsC: TaskOutcomeRow[] = [];
		const denomF: DenominatorUnit[] = [];
		const rowsF: TaskOutcomeRow[] = [];
		for (let i = 0; i < 10; i++) {
			denomC.push(unit({ agentId: `c-${i}` }));
			rowsC.push(row({ agentId: `c-${i}`, model: "claude-sonnet-5", outcome: i < 2 ? "landed" : "rejected" })); // 0.2, no costUsd
			denomF.push(unit({ agentId: `f-${i}` }));
			rowsF.push(row({ agentId: `f-${i}`, model: "claude-opus-4-8", outcome: i < 9 ? "landed" : "rejected" })); // 0.9, no costUsd
		}
		const doc = buildTaskClassMatrix([...rowsC, ...rowsF], [...denomC, ...denomF], range);
		expect(doc.cells["tdd:heavy"][ROUTE_CHEAP_FAMILY].costCoveragePct).toBe(0);
		expect(doc.cells["tdd:heavy"][ROUTE_FRONTIER_FAMILY].costCoveragePct).toBe(0);
		expect(doc.champions["tdd:heavy"]).toBe(ROUTE_FRONTIER_FAMILY);
		const decision = routeModelForTaskClass(taskClass, doc);
		expect(decision.model).toBe(ROUTE_FRONTIER_MODEL);
	});
});

// ── adw-factory-borrows concern 09: per-lane apply gating ───────────────────────────────────────

describe("modelRouteShouldApply", () => {
	afterEach(() => {
		delete process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW;
	});

	test("global apply ('0') always applies — unaffected by lane or lane source (the lane-threading.test.ts clamp contract)", () => {
		expect(modelRouteShouldApply("feature", true, "0")).toBe(true);
		expect(modelRouteShouldApply("hotfix", false, "0")).toBe(true); // label/classifier-sourced — still applies
		expect(modelRouteShouldApply("chore", false, "0")).toBe(true);
	});

	test("global unset (or anything but literal '0') defaults to shadow", () => {
		expect(modelRouteShouldApply("feature", true, undefined)).toBe(false);
		expect(modelRouteShouldApply("feature", true, "1")).toBe(false);
		expect(modelRouteShouldApply("feature", true, "nonsense")).toBe(false);
	});

	test("v1: no lane's own modelRouteApply flag is true yet, so nothing widens past a global shadow default", () => {
		expect(modelRouteShouldApply("feature", true, undefined)).toBe(false);
		expect(modelRouteShouldApply("hotfix", true, undefined)).toBe(false);
		expect(modelRouteShouldApply("chore", true, undefined)).toBe(false);
	});

	test("an operator-sourced lane's OWN flag widens past a global shadow default once flipped", () => {
		const original = LANE_POLICY.hotfix.modelRouteApply;
		LANE_POLICY.hotfix.modelRouteApply = true;
		try {
			expect(modelRouteShouldApply("hotfix", true, undefined)).toBe(true); // operator + flag flipped ⇒ widens
			expect(modelRouteShouldApply("hotfix", false, undefined)).toBe(false); // label/classifier ⇒ clamp blocks the widen
		} finally {
			LANE_POLICY.hotfix.modelRouteApply = original;
		}
	});

	test("reads the real OMP_SQUAD_MODEL_ROUTE_SHADOW env when no override argument is passed", () => {
		delete process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW;
		expect(modelRouteShouldApply("feature", true)).toBe(false); // unset ⇒ shadow, v1 flag is false
		process.env.OMP_SQUAD_MODEL_ROUTE_SHADOW = "0";
		expect(modelRouteShouldApply("feature", true)).toBe(true); // global apply ⇒ applies regardless of the lane flag
	});
});

describe("modelRouteMinEdgeFor", () => {
	test("an operator-sourced lane with an override (hotfix) gets its own lower minEdge", () => {
		expect(modelRouteMinEdgeFor("hotfix", true)).toBe(0.08);
	});

	test("a label/classifier-sourced lane (appliesPrivilege=false) never gets the override, even for hotfix", () => {
		expect(modelRouteMinEdgeFor("hotfix", false)).toBeUndefined();
	});

	test("a lane with no configured override (feature, chore) falls through to undefined — the shared MIN_EDGE floor applies", () => {
		expect(modelRouteMinEdgeFor("feature", true)).toBeUndefined();
		expect(modelRouteMinEdgeFor("chore", true)).toBeUndefined();
	});

	test("the resolved override actually changes routeModelForTaskClass's outcome vs the shared MIN_EDGE floor", () => {
		// edge 0.10 clears hotfix's lowered floor (0.08) but NOT the shared MIN_EDGE (0.15).
		const cheap = seedCell("claude-sonnet-5", 20, 9); // 0.45
		const frontier = seedCell("claude-opus-4-8", 20, 11); // 0.55 — edge 0.10
		const doc = buildTaskClassMatrix([...cheap.rows, ...frontier.rows], [...cheap.denom, ...frontier.denom], range);
		const edge = doc.cells["tdd:heavy"][ROUTE_FRONTIER_FAMILY].mergeRate - doc.cells["tdd:heavy"][ROUTE_CHEAP_FAMILY].mergeRate;
		expect(edge).toBeCloseTo(0.1, 5);
		expect(edge).toBeLessThan(MIN_EDGE);

		const atSharedFloor = routeModelForTaskClass(taskClass, doc, undefined, { minEdge: modelRouteMinEdgeFor("feature", true) });
		expect(atSharedFloor.model).toBeUndefined(); // no lane override for feature ⇒ shared 0.15 floor ⇒ no shift

		const atLaneFloor = routeModelForTaskClass(taskClass, doc, undefined, { minEdge: modelRouteMinEdgeFor("hotfix", true) });
		expect(atLaneFloor.model).toBe(ROUTE_FRONTIER_MODEL); // hotfix's 0.08 floor ⇒ shifts

		const clamped = routeModelForTaskClass(taskClass, doc, undefined, { minEdge: modelRouteMinEdgeFor("hotfix", false) });
		expect(clamped.model).toBeUndefined(); // label/classifier-sourced hotfix ⇒ clamp strips the override ⇒ shared floor ⇒ no shift
	});
});
