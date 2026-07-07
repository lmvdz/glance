import { describe, expect, test } from "bun:test";
import { buildScoreboard } from "../src/attribution-scoreboard.ts";
import type { ModelOutcomes } from "../src/model-outcomes.ts";
import type { RunReceipt } from "../src/types.ts";

const rc = (model: string, costUsd: number, harness?: string): RunReceipt => ({
	agentId: `a${Math.round(costUsd * 1000)}-${harness ?? "omp"}`,
	name: "r",
	repo: "/repo",
	model,
	runId: "r",
	startedAt: 0,
	endedAt: 1,
	durationMs: 1,
	status: "stopped",
	toolCalls: 0,
	toolTally: {},
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	costUsd,
	filesTouched: [],
	harness,
});

// Receipts carry the RAW on-disk id shapes the receipts audit found (bare vendor-family-version
// ids); the outcomes ledger is family-keyed, exactly as `readModelOutcomes` returns after the
// research-sirvir/02 migration fold. `buildScoreboard` must fold the receipt's raw id through the
// SAME `modelFamily` the ledger keys are already in, so a "claude-sonnet-5" receipt's cost joins the
// "sonnet" outcome row — the core of the key-coherence fix, exercised end to end here.
const RECEIPTS: RunReceipt[] = [
	rc("claude-sonnet-5", 0.1), // daemon (no harness → omp)
	rc("claude-sonnet-5", 0.2),
	rc("claude-sonnet-5", 0.3),
	rc("claude-opus-4-8", 1.0),
	rc("gpt-5.5", 5.0, "codex"), // external — cost counts in harnessSpend, NOT in any model's $/landed
];
const OUTCOMES: ModelOutcomes = {
	"sonnet::mid": { landed: 3, rejected: 1 },
	"sonnet::heavy": { landed: 1, rejected: 0 },
	"opus::heavy": { landed: 1, rejected: 2 },
};

describe("buildScoreboard", () => {
	const sb = buildScoreboard(RECEIPTS, OUTCOMES);
	const byModel = (m: string) => sb.models.find((x) => x.model === m)!;

	test("per-model land-rate folds all tiers, ranked by lands", () => {
		expect(sb.models.map((m) => m.model)).toEqual(["sonnet", "opus"]); // 4 lands > 1 land
		const s = byModel("sonnet");
		expect(s.landed).toBe(4);
		expect(s.rejected).toBe(1);
		expect(s.landRate).toBeCloseTo(0.8, 6);
	});

	test("per-tier breakdown is the task-class axis (light/mid/heavy)", () => {
		const s = byModel("sonnet");
		const mid = s.byTier.find((t) => t.tier === "mid")!;
		const heavy = s.byTier.find((t) => t.tier === "heavy")!;
		const light = s.byTier.find((t) => t.tier === "light")!;
		expect(mid).toMatchObject({ landed: 3, rejected: 1 });
		expect(mid.landRate).toBeCloseTo(0.75, 6);
		expect(heavy).toMatchObject({ landed: 1, rejected: 0, landRate: 1 });
		expect(light.landRate).toBeNull(); // no attempts
	});

	test("$/landed-change divides DAEMON cost by lands, excluding external-harness spend", () => {
		expect(byModel("sonnet").daemonCostUsd).toBeCloseTo(0.6, 6); // 0.1+0.2+0.3
		expect(byModel("sonnet").costPerLandedChange).toBeCloseTo(0.6 / 4, 6); // 0.15
		expect(byModel("opus").costPerLandedChange).toBeCloseTo(1.0, 6); // 1.0 / 1 land
	});

	test("external-harness spend is context only — no scoreboard row, but in harnessSpend + totals", () => {
		expect(sb.models.find((m) => m.model === "openai")).toBeUndefined();
		expect(sb.harnessSpend).toEqual([
			{ harness: "codex", runs: 1, costUsd: 5.0 }, // sorted by cost desc
			{ harness: "omp", runs: 4, costUsd: 1.6 },
		]);
		expect(sb.totals).toEqual({ landed: 5, rejected: 3, daemonCostUsd: 1.6, totalCostUsd: 6.6 });
	});

	test("a model with lands but no daemon receipts has null $/landed (no cost to divide)", () => {
		const sb2 = buildScoreboard([], { "x::mid": { landed: 2, rejected: 0 } });
		expect(sb2.models[0]).toMatchObject({ model: "x", landed: 2, daemonCostUsd: 0, costPerLandedChange: null });
	});

	test("record must equal read: raw receipt id shapes join the family-keyed ledger row, not {0} unknown", () => {
		// Two different raw shapes for the same family (provider-qualified + bare alias) both join the
		// SAME "opus" outcome row — this is the concrete manifestation of the key-coherence fix.
		const receipts: RunReceipt[] = [rc("anthropic/claude-opus-4-8", 2.0), rc("opus", 1.0)];
		const outcomes: ModelOutcomes = { "opus::heavy": { landed: 4, rejected: 1 } };
		const sb2 = buildScoreboard(receipts, outcomes);
		const opus = sb2.models.find((m) => m.model === "opus")!;
		expect(opus).toBeDefined();
		expect(opus.daemonCostUsd).toBeCloseTo(3.0, 6);
		expect(opus.landed).toBe(4);
		expect(opus.costPerLandedChange).toBeCloseTo(3.0 / 4, 6);
	});
});
