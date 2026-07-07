/**
 * Pre-execution cost projection (plans/policy-and-cost-gates/ concern C-COST) — the pure verdict logic
 * and its silence guards. Shadow-only in v1: a verdict is a line to LOG, never a block.
 */

import { afterEach, expect, test } from "bun:test";
import { costGateMode, costGateVerdict, type CostProjection } from "../src/cost-gate.ts";

const proj = (over: Partial<CostProjection>): CostProjection => ({ model: "sonnet", tier: "mid", sample: 20, landRate: 0.5, costPerLandedChange: 3, ...over });

afterEach(() => {
	delete process.env.OMP_SQUAD_COST_GATE;
	delete process.env.OMP_SQUAD_COST_MAX_PER_CHANGE;
	delete process.env.OMP_SQUAD_COST_MIN_SAMPLE;
});

test("mode defaults to off; shadow/enforce recognized", () => {
	expect(costGateMode()).toBe("off");
	process.env.OMP_SQUAD_COST_GATE = "shadow";
	expect(costGateMode()).toBe("shadow");
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	expect(costGateMode()).toBe("enforce");
	process.env.OMP_SQUAD_COST_GATE = "nonsense";
	expect(costGateMode()).toBe("off");
});

test("silent when no ceiling is configured (budget 0)", () => {
	expect(costGateVerdict(proj({ costPerLandedChange: 999 }))).toBeUndefined();
});

test("silent below the minimum sample even when over budget", () => {
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1";
	process.env.OMP_SQUAD_COST_MIN_SAMPLE = "10";
	expect(costGateVerdict(proj({ sample: 3, costPerLandedChange: 50 }))).toBeUndefined();
});

test("silent when under budget", () => {
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "10";
	expect(costGateVerdict(proj({ costPerLandedChange: 4 }))).toBeUndefined();
});

test("silent when no cost data yet", () => {
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1";
	expect(costGateVerdict(proj({ costPerLandedChange: null }))).toBeUndefined();
});

test("ASK when over budget, DENY when over 2x budget", () => {
	process.env.OMP_SQUAD_COST_GATE = "shadow";
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "5";
	const ask = costGateVerdict(proj({ costPerLandedChange: 7 }));
	expect(ask?.action).toBe("ask");
	expect(ask?.line).toContain("would ASK");
	expect(ask?.line).toContain("$7.00/landed-change");
	const deny = costGateVerdict(proj({ costPerLandedChange: 20 }));
	expect(deny?.action).toBe("deny");
	expect(deny?.line).toContain("would DENY");
});
