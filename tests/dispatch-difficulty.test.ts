import { describe, expect, test } from "bun:test";
import { DIFFICULTY_MIN_ATTEMPTS, difficultyDispatchDecision, difficultyDispatchMode, tierDifficulty } from "../src/dispatch-difficulty.ts";
import type { ModelOutcomes } from "../src/model-outcomes.ts";

describe("tierDifficulty — pooled judged evidence per tier", () => {
	test("pools across model families at the tier; blocked never counts as evidence", () => {
		const outcomes: ModelOutcomes = {
			"sonnet::mid": { landed: 0, rejected: 3, blocked: 9 },
			"opus::mid": { landed: 0, rejected: 2 },
			"sonnet::light": { landed: 5, rejected: 0 },
		};
		expect(tierDifficulty(outcomes, "mid")).toEqual({ signal: "all-fail", tier: "mid", attempts: 5, landed: 0 });
		expect(tierDifficulty(outcomes, "light")).toEqual({ signal: "all-pass", tier: "light", attempts: 5, landed: 5 });
	});

	test("below the evidence floor: insufficient-evidence, never a gating signal", () => {
		const outcomes: ModelOutcomes = { "sonnet::heavy": { landed: 0, rejected: DIFFICULTY_MIN_ATTEMPTS - 1 } };
		expect(tierDifficulty(outcomes, "heavy").signal).toBe("insufficient-evidence");
		expect(tierDifficulty({}, "mid").signal).toBe("insufficient-evidence");
	});

	test("one land breaks all-fail: mixed", () => {
		const outcomes: ModelOutcomes = { "sonnet::mid": { landed: 1, rejected: 6 } };
		expect(tierDifficulty(outcomes, "mid").signal).toBe("mixed");
	});
});

describe("difficultyDispatchMode", () => {
	test("defaults to shadow; explicit off/apply respected", () => {
		expect(difficultyDispatchMode(undefined)).toBe("shadow");
		expect(difficultyDispatchMode("shadow")).toBe("shadow");
		expect(difficultyDispatchMode("1")).toBe("apply");
		expect(difficultyDispatchMode("apply")).toBe("apply");
		expect(difficultyDispatchMode("0")).toBe("off");
		expect(difficultyDispatchMode("off")).toBe("off");
	});
});

describe("difficultyDispatchDecision", () => {
	const allFail: ModelOutcomes = { "sonnet::mid": { landed: 0, rejected: 6 } };

	test("REGRESSION (codex findings 1–3): apply mode NEVER gates — it refuses loudly and runs shadow", () => {
		const d = difficultyDispatchDecision(allFail, undefined, "apply");
		expect(d.proceed).toBeTrue();
		expect(d.reason).toContain("apply requested but gating is unshipped");
		expect(d.reason).toContain("landed 0 of 6");
	});

	test("shadow mode logs the would-skip but proceeds — model-route's rollout posture", () => {
		const d = difficultyDispatchDecision(allFail, undefined, "shadow");
		expect(d.proceed).toBeTrue();
		expect(d.reason).toContain("SHADOW (would skip)");
	});

	test("off mode neither computes nor gates", () => {
		expect(difficultyDispatchDecision(allFail, undefined, "off")).toEqual({ proceed: true, reason: "difficulty-dispatch off" });
	});

	test("mixed and insufficient evidence always proceed in every mode", () => {
		expect(difficultyDispatchDecision({ "sonnet::mid": { landed: 2, rejected: 4 } }, undefined, "apply").proceed).toBeTrue();
		expect(difficultyDispatchDecision({}, undefined, "apply").proceed).toBeTrue();
	});

	test("no mode can produce proceed:false while gating is unshipped", () => {
		const heavyFail: ModelOutcomes = { "opus::heavy": { landed: 0, rejected: 5 } };
		for (const mode of ["off", "shadow", "apply"] as const) {
			expect(difficultyDispatchDecision(heavyFail, "xhigh", mode).proceed).toBeTrue();
		}
	});
});
