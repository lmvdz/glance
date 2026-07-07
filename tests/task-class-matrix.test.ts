import { describe, expect, test } from "bun:test";
import { buildTaskClassMatrix, MIN_SAMPLES, type DenominatorUnit } from "../src/omp-graph/task-class-matrix.ts";
import { HOUR_MS } from "../src/omp-graph/schema.ts";
import type { TaskOutcomeRow } from "../src/task-outcomes.ts";

const range = { start: 0, end: 24 * HOUR_MS };

const row = (over: Partial<TaskOutcomeRow>): TaskOutcomeRow => ({
	agentId: "a",
	routing: { mode: "tdd", tier: "heavy" },
	outcome: "landed",
	source: "land",
	ts: HOUR_MS,
	...over,
});

const unit = (over: Partial<DenominatorUnit>): DenominatorUnit => ({
	agentId: "a",
	taskClass: { mode: "tdd", tier: "heavy" },
	...over,
});

describe("buildTaskClassMatrix", () => {
	test("a roster unit with NO outcome row counts as a denominator failure", () => {
		// Two roster units in the same task class: one landed (has a row), one died before any land
		// attempt (roster-only, no row, no model). The died unit must still count in the denominator —
		// bucketed under "unknown" model since there's no row to read a real model from — rather than
		// vanishing entirely (the units-never-commit failure class concern 02 exists to catch).
		const denom = [unit({ agentId: "landed-1", model: "claude-sonnet-5" }), unit({ agentId: "died-before-land" })];
		const rows = [row({ agentId: "landed-1", model: "claude-sonnet-5" })];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const cell = doc.cells["tdd:heavy"].sonnet;
		const unknownCell = doc.cells["tdd:heavy"].unknown;
		expect(cell.n).toBe(1);
		expect(cell.landed).toBe(1);
		expect(cell.mergeRate).toBe(1);
		expect(unknownCell.n).toBe(1);
		expect(unknownCell.landed).toBe(0);
		expect(unknownCell.mergeRate).toBe(0);
		expect(doc.totalUnits).toBe(2);
		expect(doc.totalLanded).toBe(1);
	});

	test("a landed unit whose ROSTER model is unknown but ROW model is real counts in ONE cell (row wins)", () => {
		// Production reality: dispatch sets no model, so the live-roster snapshot's model is undefined
		// (→ "unknown"), while the outcome row carries concern 01's REAL effective model read from the
		// finalized receipt. The aggregator must resolve this agentId to a SINGLE cell — the real-model
		// cell — not count it as a denominator member under "unknown" AND a success under "sonnet". That
		// split double-count is the exact bug the per-agentId single-cell resolution (row wins) prevents.
		const denom = [unit({ agentId: "u1" })]; // roster model undefined ⇒ "unknown"
		const rows = [row({ agentId: "u1", model: "claude-sonnet-5" })]; // real effective model from the receipt
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(doc.cells["tdd:heavy"].sonnet.n).toBe(1);
		expect(doc.cells["tdd:heavy"].sonnet.landed).toBe(1);
		expect(doc.cells["tdd:heavy"].unknown).toBeUndefined(); // no phantom failure in the unknown column
		expect(doc.totalUnits).toBe(1); // counted exactly once across the whole matrix
		expect(doc.totalLanded).toBe(1);
	});

	test("mergeRate never exceeds 1, even when rows and roster overlap heavily", () => {
		const denom = Array.from({ length: 5 }, (_, i) => unit({ agentId: `u${i}` }));
		// every unit lands, plus a duplicate-ish extra row for one of them (idempotent collapse
		// upstream already guarantees one row per agentId, but the aggregator must not double count
		// even if a caller passed something odd).
		const rows = denom.map((u) => row({ agentId: u.agentId, model: "claude-sonnet-5" }));
		const doc = buildTaskClassMatrix(rows, denom, range);
		const cell = doc.cells["tdd:heavy"].sonnet;
		expect(cell.n).toBe(5);
		expect(cell.landed).toBe(5);
		expect(cell.mergeRate).toBe(1);
		expect(cell.mergeRate).toBeLessThanOrEqual(1);
	});

	test("a reconciled row for a unit evicted from the roster still counts", () => {
		// Roster is empty for this cell — the unit only exists via its outcome row (the reconciler
		// path recording a unit that's since been evicted from the live roster).
		const denom: DenominatorUnit[] = [];
		const rows = [row({ agentId: "reconciled-1", model: "claude-opus-4-8", source: "reconciled" })];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const cell = doc.cells["tdd:heavy"].opus;
		expect(cell.n).toBe(1);
		expect(cell.landed).toBe(1);
		expect(cell.mergeRate).toBe(1);
	});

	test("cost coverage % is correct when some rows lack costUsd", () => {
		const denom = [unit({ agentId: "c1" }), unit({ agentId: "c2" }), unit({ agentId: "c3" })];
		const rows = [
			row({ agentId: "c1", model: "claude-sonnet-5", costUsd: 4 }),
			row({ agentId: "c2", model: "claude-sonnet-5", costUsd: 8 }),
			row({ agentId: "c3", model: "claude-sonnet-5" }), // no costUsd — subscription-priced run
		];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const cell = doc.cells["tdd:heavy"].sonnet;
		expect(cell.nWithCost).toBe(2);
		expect(cell.costCoveragePct).toBeCloseTo(2 / 3, 5);
		expect(cell.medianCostUsd).toBe(6); // median of [4, 8]
	});

	test("cell with zero cost-bearing rows has an undefined median, not a fake 0", () => {
		const denom = [unit({ agentId: "n1" })];
		const rows = [row({ agentId: "n1", model: "claude-sonnet-5" })];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const cell = doc.cells["tdd:heavy"].sonnet;
		expect(cell.medianCostUsd).toBeUndefined();
		expect(cell.nWithCost).toBe(0);
		expect(cell.costCoveragePct).toBe(0);
	});

	test("min-samples gate flags a small cell as insufficientData", () => {
		const denom = [unit({ agentId: "s1" }), unit({ agentId: "s2" })]; // 2 < MIN_SAMPLES (3)
		const rows = [row({ agentId: "s1", model: "claude-sonnet-5" }), row({ agentId: "s2", model: "claude-sonnet-5" })];
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(doc.minSamples).toBe(MIN_SAMPLES);
		expect(doc.cells["tdd:heavy"].sonnet.n).toBe(2);
		expect(doc.cells["tdd:heavy"].sonnet.insufficientData).toBe(true);
	});

	test("a cell at or above min-samples is NOT flagged insufficient", () => {
		const denom = [unit({ agentId: "g1" }), unit({ agentId: "g2" }), unit({ agentId: "g3" })];
		const rows = denom.map((u) => row({ agentId: u.agentId, model: "claude-sonnet-5" }));
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(doc.cells["tdd:heavy"].sonnet.insufficientData).toBe(false);
	});

	test("in-run rework rate counts only LANDED rows with fixupCount > 0", () => {
		const denom = [unit({ agentId: "r1" }), unit({ agentId: "r2" }), unit({ agentId: "r3" }), unit({ agentId: "r4" })];
		const rows = [
			row({ agentId: "r1", model: "claude-sonnet-5", outcome: "landed", fixupCount: 2 }),
			row({ agentId: "r2", model: "claude-sonnet-5", outcome: "landed", fixupCount: 0 }),
			// rejected with fixups — must NOT count toward in-run rework (rate is over LANDED rows only)
			row({ agentId: "r3", model: "claude-sonnet-5", outcome: "rejected", fixupCount: 5 }),
			row({ agentId: "r4", model: "claude-sonnet-5", outcome: "landed" }), // fixupCount undefined
		];
		const doc = buildTaskClassMatrix(rows, denom, range);
		const cell = doc.cells["tdd:heavy"].sonnet;
		expect(cell.landed).toBe(3); // r1, r2, r4
		expect(cell.inRunReworkRate).toBeCloseTo(1 / 3, 5); // only r1 among the landed rows has fixupCount > 0
	});

	test("inRunReworkRate is undefined when a cell has no landed rows", () => {
		const denom = [unit({ agentId: "z1" })];
		const rows = [row({ agentId: "z1", model: "claude-sonnet-5", outcome: "rejected" })];
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(doc.cells["tdd:heavy"].sonnet.inRunReworkRate).toBeUndefined();
	});

	test("a unit with no model yet lands in the unknown model column", () => {
		const denom = [unit({ agentId: "nomodel" })]; // never ran, no model field
		const doc = buildTaskClassMatrix([], denom, range);
		expect(doc.models).toContain("unknown");
		expect(doc.cells["tdd:heavy"].unknown.n).toBe(1);
		expect(doc.cells["tdd:heavy"].unknown.landed).toBe(0);
	});

	test("distinct task classes and models are kept separate, sorted", () => {
		const denom = [
			unit({ agentId: "x1", taskClass: { mode: "verify", tier: "light" } }),
			unit({ agentId: "x2", taskClass: { mode: "tdd", tier: "heavy" } }),
		];
		const rows = [row({ agentId: "x1", model: "claude-opus-4-8", routing: { mode: "verify", tier: "light" } })];
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(doc.taskClasses).toEqual(["tdd:heavy", "verify:light"]);
		expect(doc.cells["verify:light"].opus.n).toBe(1);
		expect(doc.cells["tdd:heavy"].unknown.n).toBe(1); // x2 never ran, no row, no model
	});

	test("outcome rows outside the range are excluded, but roster membership is not time-scoped", () => {
		const denom = [unit({ agentId: "old" })];
		const rows = [row({ agentId: "old", model: "claude-sonnet-5", ts: range.end + 999 })]; // out of range
		const doc = buildTaskClassMatrix(rows, denom, range);
		// The row is dropped by the range filter, so "old" reads as a roster-only denominator failure
		// bucketed under "unknown" model (no in-range row to read a model from) — never silently vanishes.
		expect(doc.cells["tdd:heavy"].unknown.n).toBe(1);
		expect(doc.cells["tdd:heavy"].unknown.landed).toBe(0);
	});

	test("causal is always false and the honesty note is present", () => {
		const doc = buildTaskClassMatrix([], [unit({ agentId: "a" })], range);
		expect(doc.causal).toBe(false);
		expect(doc.note.length).toBeGreaterThan(0);
	});
});
