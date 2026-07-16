/**
 * Pre-execution cost projection (plans/policy-and-cost-gates/ concern C-COST) — the pure verdict logic
 * and its silence guards. Shadow-only in v1: a verdict is a line to LOG, never a block.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import { costGateAggregateReady, costGateMode, costGateVerdict, shadowCostCheck, type CostProjection } from "../src/cost-gate.ts";
import * as modelOutcomesModule from "../src/model-outcomes.ts";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

// ── adw-factory-borrows concern 09: per-lane enforce ────────────────────────────────────────────

test("chore lane DENIES over its own ceiling ($2), even at a dollar amount that would only ASK by the old 2x heuristic", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	// $3 is 1.5x the chore ceiling ($2) — under the OLD lane-less 2x-for-deny heuristic this would only
	// ASK. The lane's own costAction ("deny" for chore, v1 rollout) is what actually decides here.
	const verdict = costGateVerdict(proj({ costPerLandedChange: 3 }), "chore");
	expect(verdict?.action).toBe("deny");
	expect(verdict?.line).toContain("would DENY");
	expect(verdict?.line).toContain("/chore ");
});

test("chore lane falls silent below the min sample even over its ceiling", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	process.env.OMP_SQUAD_COST_MIN_SAMPLE = "10";
	expect(costGateVerdict(proj({ sample: 3, costPerLandedChange: 50 }), "chore")).toBeUndefined();
});

test("hotfix lane never denies (or asks) in v1 — its costAction is shadow, no matter the dollar amount", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1"; // hotfix has no lane ceiling override — falls back to global
	const verdict = costGateVerdict(proj({ costPerLandedChange: 999 }), "hotfix");
	expect(verdict?.action).toBe("shadow");
	expect(verdict?.line).toContain("would SHADOW");
});

test("feature lane also stays shadow in v1 (only chore denies)", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1";
	const verdict = costGateVerdict(proj({ costPerLandedChange: 999 }), "feature");
	expect(verdict?.action).toBe("shadow");
});

test("chore lane's own $2 ceiling fires even with no global OMP_SQUAD_COST_MAX_PER_CHANGE set", () => {
	// No global ceiling configured at all — the lane's own costCeilingUsd must still gate.
	const verdict = costGateVerdict(proj({ costPerLandedChange: 3 }), "chore");
	expect(verdict?.action).toBe("deny");
});

// ── review follow-up: laneAppliesPrivilege clamp (mirrors model-route.ts's modelRouteMinEdgeFor) ──
//
// A label/classifier-sourced lane (laneAppliesPrivilege=false) may only move the cost axis STRICTER
// than LANE_POLICY.feature's row, never looser — closing the "future lane row looser than feature's
// becomes purchasable by ticket text" gap the review flagged. Today it's a no-op for chore (already
// stricter than feature) and for hotfix (no own ceiling, same action as feature) — these tests prove
// the clamp doesn't regress existing behavior AND actually bites when a row IS looser.

test("privilege clamp: chore denying (stricter than feature's shadow) is UNCHANGED for a non-privileged (classifier/label) lane", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	const verdict = costGateVerdict(proj({ costPerLandedChange: 3 }), "chore", false);
	expect(verdict?.action).toBe("deny"); // moving stricter on ticket text alone is exactly what DESIGN.md allows
});

test("privilege clamp: a lane-defined ceiling ABOVE the global is capped to the global for a non-privileged lane", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1"; // operator's global ceiling: $1, stricter than chore's own $2
	// $1.50/landed-change: UNDER chore's own $2 ceiling but OVER the $1 global.
	// A privileged (operator-sourced) caller uses chore's own $2 ceiling verbatim — silent (under budget).
	const privileged = costGateVerdict(proj({ costPerLandedChange: 1.5 }), "chore", true);
	expect(privileged).toBeUndefined();
	// A non-privileged (classifier/label) caller must be clamped to the STRICTER global ($1) — the same
	// $1.50/landed-change now denies, proving the ceiling is actually compared against the global rather
	// than silently trusting the lane's own (looser) row:
	const clamped = costGateVerdict(proj({ costPerLandedChange: 1.5 }), "chore", false);
	expect(clamped?.action).toBe("deny");
	expect(clamped?.line).toContain("over budget $1.00"); // clamped to the global, not chore's own $2
});

test("privilege clamp: action never drops below feature's own (there is no lane looser than feature today, so this is a no-op guard)", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	process.env.OMP_SQUAD_COST_MAX_PER_CHANGE = "1";
	const privileged = costGateVerdict(proj({ costPerLandedChange: 999 }), "hotfix", true);
	const clamped = costGateVerdict(proj({ costPerLandedChange: 999 }), "hotfix", false);
	expect(privileged?.action).toBe("shadow");
	expect(clamped?.action).toBe("shadow"); // already at the floor — clamp is a no-op, not a regression
});

test("privilege clamp defaults to true (operator-privileged) when unspecified — no behavior change for existing callers", () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	const withDefault = costGateVerdict(proj({ costPerLandedChange: 3 }), "chore");
	const explicitTrue = costGateVerdict(proj({ costPerLandedChange: 3 }), "chore", true);
	expect(withDefault).toEqual(explicitTrue);
});

// ── review follow-up: shadowCostCheck must LOG (never swallow silently) when the projection itself
// throws — the exact "absence of evidence read as evidence of absence" shape this repo's review
// history keeps catching. `modelOutcomes` is spied (not `mock.module`, which would leak process-wide
// to every other suite importing model-outcomes.ts) so the throw is injected surgically and restored
// immediately after.

test("shadowCostCheck logs a 'check failed' line (never silent) when the projection throws under enforce", async () => {
	process.env.OMP_SQUAD_COST_GATE = "enforce";
	const spy = spyOn(modelOutcomesModule, "modelOutcomes").mockImplementation(() => {
		throw new Error("simulated ledger corruption");
	});
	try {
		const lines: string[] = [];
		const verdict = await shadowCostCheck("/tmp/cost-gate-test-does-not-exist", "sonnet", "mid", (line) => lines.push(line), "chore");
		expect(verdict).toBeUndefined(); // still never blocks/throws outward
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("cost-gate(enforce)");
		expect(lines[0]).toContain("check failed");
		expect(lines[0]).toContain("simulated ledger corruption");
	} finally {
		spy.mockRestore();
	}
});

test("shadowCostCheck logs nothing extra on the happy path (no regression from the new catch logging)", async () => {
	process.env.OMP_SQUAD_COST_GATE = "shadow";
	const lines: string[] = [];
	const verdict = await shadowCostCheck(mkdtempSync(path.join(os.tmpdir(), "cost-gate-happy-")), "sonnet", "mid", (line) => lines.push(line));
	expect(verdict).toBeUndefined(); // no ceiling configured, no data seeded — silent, not a "check failed" line
	expect(lines).toHaveLength(0);
});

// ── costGateAggregateReady (glance doctor's config-posture check, review follow-up) ──────────────

test("costGateAggregateReady: false on a fresh/empty stateDir (nothing to verdict on)", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "cost-gate-ready-empty-"));
	try {
		expect(await costGateAggregateReady(dir)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("costGateAggregateReady: true once the model-outcomes ledger clears OMP_SQUAD_COST_MIN_SAMPLE", async () => {
	const { recordModelOutcome } = await import("../src/model-outcomes.ts");
	const dir = mkdtempSync(path.join(os.tmpdir(), "cost-gate-ready-thin-"));
	try {
		for (let i = 0; i < 4; i++) recordModelOutcome(dir, "sonnet", "mid", true);
		process.env.OMP_SQUAD_COST_MIN_SAMPLE = "5";
		expect(await costGateAggregateReady(dir)).toBe(false); // 4 < 5, still thin
		recordModelOutcome(dir, "sonnet", "mid", true); // 5th sample clears the floor
		expect(await costGateAggregateReady(dir)).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
