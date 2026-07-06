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

const RECEIPTS: RunReceipt[] = [
	rc("claude-sonnet-5", 0.1), // daemon (no harness → omp)
	rc("claude-sonnet-5", 0.2),
	rc("claude-sonnet-5", 0.3),
	rc("claude-opus-4-8", 1.0),
	rc("gpt-5.5", 5.0, "codex"), // external — cost counts in harnessSpend, NOT in any model's $/landed
];
const OUTCOMES: ModelOutcomes = {
	"claude-sonnet-5::mid": { landed: 3, rejected: 1 },
	"claude-sonnet-5::heavy": { landed: 1, rejected: 0 },
	"claude-opus-4-8::heavy": { landed: 1, rejected: 2 },
};

describe("buildScoreboard", () => {
	const sb = buildScoreboard(RECEIPTS, OUTCOMES);
	const byModel = (m: string) => sb.models.find((x) => x.model === m)!;

	test("per-model land-rate folds all tiers, ranked by lands", () => {
		expect(sb.models.map((m) => m.model)).toEqual(["claude-sonnet-5", "claude-opus-4-8"]); // 4 lands > 1 land
		const s = byModel("claude-sonnet-5");
		expect(s.landed).toBe(4);
		expect(s.rejected).toBe(1);
		expect(s.landRate).toBeCloseTo(0.8, 6);
	});

	test("per-tier breakdown is the task-class axis (light/mid/heavy)", () => {
		const s = byModel("claude-sonnet-5");
		const mid = s.byTier.find((t) => t.tier === "mid")!;
		const heavy = s.byTier.find((t) => t.tier === "heavy")!;
		const light = s.byTier.find((t) => t.tier === "light")!;
		expect(mid).toMatchObject({ landed: 3, rejected: 1 });
		expect(mid.landRate).toBeCloseTo(0.75, 6);
		expect(heavy).toMatchObject({ landed: 1, rejected: 0, landRate: 1 });
		expect(light.landRate).toBeNull(); // no attempts
	});

	test("$/landed-change divides DAEMON cost by lands, excluding external-harness spend", () => {
		expect(byModel("claude-sonnet-5").daemonCostUsd).toBeCloseTo(0.6, 6); // 0.1+0.2+0.3
		expect(byModel("claude-sonnet-5").costPerLandedChange).toBeCloseTo(0.6 / 4, 6); // 0.15
		expect(byModel("claude-opus-4-8").costPerLandedChange).toBeCloseTo(1.0, 6); // 1.0 / 1 land
	});

	test("external-harness spend is context only — no scoreboard row, but in harnessSpend + totals", () => {
		expect(sb.models.find((m) => m.model === "gpt-5.5")).toBeUndefined();
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
});
