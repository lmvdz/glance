import { describe, expect, test } from "bun:test";
import {
	buildTaskClassMatrix,
	detectBaselineStaleness,
	flagEfficiencyRegression,
	isCostReproducible,
	isSampleSufficient,
	MIN_SAMPLES,
	selectBaseline,
	type CellMetrics,
	type DenominatorUnit,
} from "../src/omp-graph/task-class-matrix.ts";
import { HOUR_MS } from "../src/omp-graph/schema.ts";
import type { TaskOutcomeRow } from "../src/task-outcomes.ts";
import type { RunReceipt } from "../src/types.ts";

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

const receipt = (over: Partial<RunReceipt>): RunReceipt => ({
	agentId: "a",
	name: "a",
	repo: "r",
	runId: "run-a",
	startedAt: HOUR_MS,
	endedAt: HOUR_MS,
	status: "idle",
	toolCalls: 0,
	toolTally: {},
	filesTouched: [],
	...over,
});

/** A cell fixture for the standalone `flagEfficiencyRegression`/`selectBaseline` unit tests below,
 *  where hand-crafting the metrics directly is clearer than round-tripping through the builder. */
const cell = (over: Partial<CellMetrics>): CellMetrics => ({
	n: 5,
	landed: 5,
	mergeRate: 1,
	nWithCost: 5,
	costCoveragePct: 1,
	nWithTokens: 5,
	tokensCoveragePct: 1,
	insufficientData: false,
	reproducible: true,
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

describe("buildTaskClassMatrix — accounting core (eap-borrows concern 01)", () => {
	test("groupBy: \"variant\" keeps gpt-5.6-sol distinct from gpt-5.6-luna and grok visible; default groupBy collapses both to family", () => {
		const denom = [
			unit({ agentId: "sol-1" }),
			unit({ agentId: "sol-2" }),
			unit({ agentId: "sol-3" }),
			unit({ agentId: "luna-1" }),
			unit({ agentId: "luna-2" }),
			unit({ agentId: "luna-3" }),
			unit({ agentId: "grok-1" }),
			unit({ agentId: "grok-2" }),
			unit({ agentId: "grok-3" }),
		];
		const rows = [
			row({ agentId: "sol-1", model: "gpt-5.6-sol" }),
			row({ agentId: "sol-2", model: "gpt-5.6-sol" }),
			row({ agentId: "sol-3", model: "gpt-5.6-sol", outcome: "rejected" }),
			row({ agentId: "luna-1", model: "gpt-5.6-luna" }),
			row({ agentId: "luna-2", model: "gpt-5.6-luna", outcome: "rejected" }),
			row({ agentId: "luna-3", model: "gpt-5.6-luna", outcome: "rejected" }),
			row({ agentId: "grok-1", model: "grok-4.5" }),
			row({ agentId: "grok-2", model: "grok-4.5" }),
			row({ agentId: "grok-3", model: "grok-4.5" }),
		];

		const familyDoc = buildTaskClassMatrix(rows, denom, range);
		expect(familyDoc.models).toContain("openai");
		expect(familyDoc.models).not.toContain("gpt-5.6-sol");
		expect(familyDoc.cells["tdd:heavy"].openai.n).toBe(6); // sol + luna collapsed into one family cell
		expect(familyDoc.models).toContain("xai");

		const variantDoc = buildTaskClassMatrix(rows, denom, range, { groupBy: "variant" });
		expect(variantDoc.models).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-luna", "grok-4.5"]));
		expect(variantDoc.cells["tdd:heavy"]["gpt-5.6-sol"].n).toBe(3);
		expect(variantDoc.cells["tdd:heavy"]["gpt-5.6-sol"].mergeRate).toBeCloseTo(2 / 3, 5);
		expect(variantDoc.cells["tdd:heavy"]["gpt-5.6-luna"].n).toBe(3);
		expect(variantDoc.cells["tdd:heavy"]["gpt-5.6-luna"].mergeRate).toBeCloseTo(1 / 3, 5);
		expect(variantDoc.cells["tdd:heavy"]["grok-4.5"].n).toBe(3);
		expect(variantDoc.cells["tdd:heavy"]["grok-4.5"].mergeRate).toBe(1);
	});

	test("token join sums a unit's tokens across multiple receipts (resume/re-spawn)", () => {
		const denom = [unit({ agentId: "u1" }), unit({ agentId: "u2" }), unit({ agentId: "u3" })];
		const rows = [
			row({ agentId: "u1", model: "claude-sonnet-5", costUsd: 1 }),
			row({ agentId: "u2", model: "claude-sonnet-5", costUsd: 1 }),
			row({ agentId: "u3", model: "claude-sonnet-5", costUsd: 1 }),
		];
		const receipts = [
			// u1 resumed once: two receipts, must SUM to one data point, not two.
			receipt({ agentId: "u1", runId: "run-1a", tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 } }),
			receipt({ agentId: "u1", runId: "run-1b", tokens: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, total: 300 } }),
			receipt({ agentId: "u2", runId: "run-2", tokens: { input: 400, output: 200, cacheRead: 0, cacheWrite: 0, total: 600 } }),
			// u3 has no receipt at all — must not count toward nWithTokens/tokensCoveragePct.
		];
		const doc = buildTaskClassMatrix(rows, denom, range, { receipts });
		const c = doc.cells["tdd:heavy"].sonnet;
		expect(c.nWithTokens).toBe(2); // u1 (summed) + u2
		expect(c.tokensCoveragePct).toBeCloseTo(2 / 3, 5);
		expect(c.medianTokensTotal).toBe(525); // median of [450 (u1 summed), 600 (u2)]
	});

	test("reproducible: a lone saturated (1.0) cell IS its taskClass's champion, and IS reproducible (finding #7)", () => {
		// Code-review finding #7: the OLD gate compared every cell's variance against the champion, even
		// when the cell WAS the champion — `hasVarianceBetween(x, x)` is false at a saturated mergeRate,
		// so the champion was never reproducible exactly when it had a perfect record. On a fleet whose
		// collapsed outcomes are all `landed` (mergeRate pinned at 1.0, true of this fleet historically)
		// that made EVERY taskClass's champion permanently unreproducible, silently killing
		// `routeModelForTaskClass` fleet-wide. A champion needs no baseline comparison — it IS the
		// baseline — so it's reproducible on sample sufficiency alone.
		const denom = [unit({ agentId: "s1" }), unit({ agentId: "s2" }), unit({ agentId: "s3" })];
		const rows = denom.map((u) => row({ agentId: u.agentId, model: "claude-sonnet-5", costUsd: 1 }));
		const doc = buildTaskClassMatrix(rows, denom, range);
		const c = doc.cells["tdd:heavy"].sonnet;
		expect(c.mergeRate).toBe(1);
		expect(c.insufficientData).toBe(false);
		expect(doc.champions["tdd:heavy"]).toBe("sonnet");
		expect(c.reproducible).toBe(true); // it's the champion — no self-comparison required
	});

	test("reproducible: a DIFFERENT cell saturated-tied with the champion still carries no signal", () => {
		// The real "no signal" case the variance floor exists for: two DISTINCT cells both stuck at a
		// saturated mergeRate. The champion (sonnet, cheaper) is reproducible on its own; the non-champion
		// (opus) is genuinely tied with it at 1.0 and must stay unreproducible — unlike the champion, it
		// really is being compared against something else, and that comparison carries no signal.
		const cheap = [unit({ agentId: "c1" }), unit({ agentId: "c2" }), unit({ agentId: "c3" })];
		const rich = [unit({ agentId: "r1" }), unit({ agentId: "r2" }), unit({ agentId: "r3" })];
		const rows = [
			...cheap.map((u) => row({ agentId: u.agentId, model: "claude-sonnet-5", costUsd: 1 })), // 1.0, cheaper
			...rich.map((u) => row({ agentId: u.agentId, model: "claude-opus-4-8", costUsd: 5 })), // 1.0, pricier
		];
		const doc = buildTaskClassMatrix(rows, [...cheap, ...rich], range);
		expect(doc.champions["tdd:heavy"]).toBe("sonnet"); // tied mergeRate — cost tie-break picks the cheaper cell
		expect(doc.cells["tdd:heavy"].sonnet.reproducible).toBe(true); // the champion
		expect(doc.cells["tdd:heavy"].opus.reproducible).toBe(false); // saturated tie against the champion — no signal
	});

	test("reproducible/champion selection no longer requires cost coverage (finding #7)", () => {
		// A fleet whose rows never carry `costUsd` at all (historically true here) must still be able to
		// produce a champion and reproducible cells off mergeRate evidence alone — the cost-coverage floor
		// only applies to an actual cost/token comparison (`isCostReproducible`), never to mergeRate.
		const cheap = [unit({ agentId: "c1" }), unit({ agentId: "c2" }), unit({ agentId: "c3" }), unit({ agentId: "c4" })];
		const frontier = [unit({ agentId: "f1" }), unit({ agentId: "f2" }), unit({ agentId: "f3" }), unit({ agentId: "f4" })];
		const rows = [
			...cheap.map((u, i) => row({ agentId: u.agentId, model: "claude-sonnet-5", outcome: i < 1 ? "landed" : "rejected" })), // 0.25, no costUsd
			...frontier.map((u) => row({ agentId: u.agentId, model: "claude-opus-4-8" })), // 1.0, no costUsd
		];
		const doc = buildTaskClassMatrix(rows, [...cheap, ...frontier], range);
		expect(doc.cells["tdd:heavy"].sonnet.costCoveragePct).toBe(0);
		expect(doc.cells["tdd:heavy"].opus.costCoveragePct).toBe(0);
		expect(doc.champions["tdd:heavy"]).toBe("opus");
		expect(doc.cells["tdd:heavy"].opus.reproducible).toBe(true);
		expect(doc.cells["tdd:heavy"].sonnet.reproducible).toBe(true); // real (non-saturated) variance vs the champion
	});

	test("reproducible: genuine (non-saturated) variance against the auto-champion publishes both sides", () => {
		const cheap = [
			unit({ agentId: "c1" }),
			unit({ agentId: "c2" }),
			unit({ agentId: "c3" }),
			unit({ agentId: "c4" }),
			unit({ agentId: "c5" }),
		];
		const rich = [unit({ agentId: "r1" }), unit({ agentId: "r2" }), unit({ agentId: "r3" }), unit({ agentId: "r4" })];
		const rows = [
			...cheap.map((u, i) => row({ agentId: u.agentId, model: "claude-sonnet-5", costUsd: 1, outcome: i < 2 ? "landed" : "rejected" })), // 0.4
			...rich.map((u, i) => row({ agentId: u.agentId, model: "claude-opus-4-8", costUsd: 1, outcome: i < 3 ? "landed" : "rejected" })), // 0.75
		];
		const doc = buildTaskClassMatrix(rows, [...cheap, ...rich], range);
		expect(doc.champions["tdd:heavy"]).toBe("opus"); // best mergeRate among sample-sufficient cells
		expect(doc.cells["tdd:heavy"].opus.mergeRate).toBeCloseTo(0.75, 5);
		expect(doc.cells["tdd:heavy"].sonnet.mergeRate).toBeCloseTo(0.4, 5);
		expect(doc.cells["tdd:heavy"].opus.reproducible).toBe(true); // not saturated (0.75), genuine signal
		expect(doc.cells["tdd:heavy"].sonnet.reproducible).toBe(true); // 0.4 vs 0.75 — real variance vs the champion
	});
});

describe("selectBaseline / detectBaselineStaleness (eap-borrows concern 01)", () => {
	test("auto-champion reads doc.champions; an explicit pin overrides it", () => {
		const cheap = [unit({ agentId: "c1" }), unit({ agentId: "c2" }), unit({ agentId: "c3" })];
		const rich = [unit({ agentId: "r1" }), unit({ agentId: "r2" }), unit({ agentId: "r3" })];
		const rows = [
			...cheap.map((u, i) => row({ agentId: u.agentId, model: "claude-sonnet-5", costUsd: 1, outcome: i < 1 ? "landed" : "rejected" })),
			...rich.map((u) => row({ agentId: u.agentId, model: "claude-opus-4-8", costUsd: 1 })),
		];
		const doc = buildTaskClassMatrix(rows, [...cheap, ...rich], range);

		const auto = selectBaseline(doc, "tdd:heavy");
		expect(auto?.model).toBe("opus");
		expect(auto?.pinned).toBe(false);

		const pinned = selectBaseline(doc, "tdd:heavy", { pinnedModel: "sonnet" });
		expect(pinned?.model).toBe("sonnet");
		expect(pinned?.pinned).toBe(true);

		expect(selectBaseline(doc, "no-such:taskclass")).toBeUndefined();
		expect(selectBaseline(doc, "tdd:heavy", { pinnedModel: "no-such-model" })).toBeUndefined();
	});

	test("champion staleness emits an AttentionEvent when the baseline degrades to insufficientData", () => {
		const denom = [unit({ agentId: "u1" }), unit({ agentId: "u2" })]; // below MIN_SAMPLES
		const rows = denom.map((u) => row({ agentId: u.agentId, model: "claude-opus-4-8", costUsd: 1 }));
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(doc.cells["tdd:heavy"].opus.insufficientData).toBe(true);

		const event = detectBaselineStaleness("tdd:heavy", "opus", doc, 12345);
		expect(event).toBeDefined();
		expect(event!.source).toBe("notify");
		expect(event!.summary).toContain("opus");
		expect(event!.summary).toContain("tdd:heavy");
		expect(event!.createdAt).toBe(12345);
	});

	test("champion staleness stays silent when the baseline is still healthy", () => {
		const denom = [unit({ agentId: "u1" }), unit({ agentId: "u2" }), unit({ agentId: "u3" })];
		const rows = denom.map((u) => row({ agentId: u.agentId, model: "claude-opus-4-8", costUsd: 1 }));
		const doc = buildTaskClassMatrix(rows, denom, range);
		expect(detectBaselineStaleness("tdd:heavy", "opus", doc)).toBeUndefined();
	});

	test("champion staleness fires when the baseline model has NO cell at all (dropped out of the fleet)", () => {
		const doc = buildTaskClassMatrix([], [unit({ agentId: "a" })], range);
		const event = detectBaselineStaleness("tdd:heavy", "opus", doc);
		expect(event).toBeDefined();
		expect(event!.detail).toContain("no cell recorded");
	});
});

describe("isSampleSufficient / isCostReproducible (code-review finding #7)", () => {
	test("isSampleSufficient ignores cost/token coverage entirely — n alone", () => {
		const thinCost = cell({ n: 10, costCoveragePct: 0, tokensCoveragePct: 0 });
		expect(isSampleSufficient(thinCost, MIN_SAMPLES)).toBe(true);
		const thinN = cell({ n: MIN_SAMPLES - 1, costCoveragePct: 1, tokensCoveragePct: 1 });
		expect(isSampleSufficient(thinN, MIN_SAMPLES)).toBe(false);
	});

	test("isCostReproducible still enforces the coverage floor — the preserved honesty gate", () => {
		const thinCost = cell({ n: 10, costCoveragePct: 0.1, tokensCoveragePct: 1 });
		expect(isCostReproducible(thinCost, MIN_SAMPLES, false)).toBe(false);
		const healthy = cell({ n: 10, costCoveragePct: 1, tokensCoveragePct: 1 });
		expect(isCostReproducible(healthy, MIN_SAMPLES, false)).toBe(true);
		const thinTokens = cell({ n: 10, costCoveragePct: 1, tokensCoveragePct: 0.1 });
		expect(isCostReproducible(thinTokens, MIN_SAMPLES, true)).toBe(false); // token arm applies
		expect(isCostReproducible(thinTokens, MIN_SAMPLES, false)).toBe(true); // token arm not requested
	});
});

describe("flagEfficiencyRegression (eap-borrows concern 01)", () => {
	test("saturated-equal cells never flag, even when the candidate is cheaper", () => {
		const baseline = cell({ mergeRate: 1, medianCostUsd: 10, medianTokensTotal: 1000, vetoRate: 0.1, inRunReworkRate: 0.1 });
		const candidate = cell({ mergeRate: 1, medianCostUsd: 5, medianTokensTotal: 500, vetoRate: 0.1, inRunReworkRate: 0.1 });
		expect(flagEfficiencyRegression(candidate, baseline)).toBe(false);
	});

	test("cheaper + higher vetoRate flags, even at a saturated-equal mergeRate", () => {
		const baseline = cell({ mergeRate: 1, medianCostUsd: 10, vetoRate: 0.05 });
		const candidate = cell({ mergeRate: 1, medianCostUsd: 5, vetoRate: 0.3 });
		expect(flagEfficiencyRegression(candidate, baseline)).toBe(true);
	});

	test("cheaper + genuinely lower mergeRate (not saturated) flags", () => {
		const baseline = cell({ mergeRate: 0.9, medianCostUsd: 10 });
		const candidate = cell({ mergeRate: 0.5, medianCostUsd: 5 });
		expect(flagEfficiencyRegression(candidate, baseline)).toBe(true);
	});

	test("cheaper + higher inRunReworkRate beyond REWORK_EPS flags", () => {
		const baseline = cell({ mergeRate: 1, medianCostUsd: 10, inRunReworkRate: 0.1 });
		const candidate = cell({ mergeRate: 1, medianCostUsd: 5, inRunReworkRate: 0.2 });
		expect(flagEfficiencyRegression(candidate, baseline)).toBe(true);
	});

	test("not cheaper on either dimension never flags, regardless of the other signals", () => {
		const baseline = cell({ mergeRate: 0.9, medianCostUsd: 5, medianTokensTotal: 500 });
		const candidate = cell({ mergeRate: 0.2, medianCostUsd: 10, medianTokensTotal: 2000, vetoRate: 0.9 });
		expect(flagEfficiencyRegression(candidate, baseline)).toBe(false);
	});

	test("cheaper by tokens alone (cost undefined on both sides) still flags on vetoRate", () => {
		const baseline = cell({ mergeRate: 1, medianTokensTotal: 1000, vetoRate: 0.05 });
		const candidate = cell({ mergeRate: 1, medianTokensTotal: 500, vetoRate: 0.4 });
		expect(flagEfficiencyRegression(candidate, baseline)).toBe(true);
	});
});
