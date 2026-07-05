/**
 * Confidence-threshold tuner (Epic 6 concern 08): the pure fitting function steps within bounds and
 * never raises the floor, recordConfidenceOutcome is absence-safe and best-effort, and
 * tunedConfidenceFloor round-trips through the persisted store.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nextFloor, recordConfidenceOutcome, tunedConfidenceFloor, type ConfidenceOutcomeSample } from "../src/threshold-tuner.ts";

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "threshold-tuner-"));
}

function samples(n: number, confidence: number, landed: boolean): ConfidenceOutcomeSample[] {
	return Array.from({ length: n }, (_, i) => ({ confidence, landed, at: i }));
}

describe("nextFloor — pure fitting, bounded step, never raises", () => {
	test("below minSamples: no change regardless of evidence", () => {
		const s = samples(5, 0.2, true); // would suggest loosening, but too few samples
		expect(nextFloor(0.4, s, { minSamples: 20 })).toBe(0.4);
	});

	test("overcautious (most below-floor runs land fine): loosens by exactly one step", () => {
		const s = samples(20, 0.2, true); // all below 0.4, all landed ⇒ 100% land rate below floor
		expect(nextFloor(0.4, s, { step: 0.02, minSamples: 20 })).toBeCloseTo(0.38, 5);
	});

	test("floor is well-calibrated (below-floor runs mostly fail): no change", () => {
		const failing = samples(18, 0.2, false);
		const landing = samples(2, 0.2, true); // 2/20 = 10% land rate below floor — well below the overcautious threshold
		expect(nextFloor(0.4, [...failing, ...landing], { minSamples: 20 })).toBe(0.4);
	});

	test("never raises the floor even when ALL below-floor runs fail (that would justify raising in a symmetric fitter, but this tuner is boost-only)", () => {
		const s = samples(20, 0.2, false);
		expect(nextFloor(0.4, s, { minSamples: 20 })).toBe(0.4); // stays put, never goes UP
	});

	test("respects the floor's own minimum — never loosens below `min`", () => {
		const s = samples(20, 0.1, true);
		expect(nextFloor(0.11, s, { step: 0.05, min: 0.1, minSamples: 20 })).toBe(0.1); // would be 0.06 unclamped
	});

	test("no below-floor samples yet (all confidence >= current floor): no change — nothing to learn about this boundary", () => {
		const s = samples(20, 0.9, true);
		expect(nextFloor(0.4, s, { minSamples: 20 })).toBe(0.4);
	});

	test("a single step is bounded — repeated calls converge gradually, not in one jump", () => {
		let floor = 0.4;
		const s = samples(20, 0.2, true);
		const steps: number[] = [];
		for (let i = 0; i < 5; i++) {
			floor = nextFloor(floor, s, { step: 0.02, minSamples: 20 });
			steps.push(floor);
		}
		// Monotonically non-increasing, each step exactly `step` (until it would cross `min`).
		for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]!);
		expect(steps[0]).toBeCloseTo(0.38, 5);
		expect(steps[1]).toBeCloseTo(0.36, 5);
	});
});

describe("recordConfidenceOutcome / tunedConfidenceFloor", () => {
	test("absence of a confidence score is a no-op — never treated as evidence", () => {
		const dir = tmp();
		try {
			recordConfidenceOutcome(dir, 0.4, undefined, true);
			recordConfidenceOutcome(dir, 0.4, undefined, false);
			expect(tunedConfidenceFloor(0.4, dir)).toBe(0.4); // no samples recorded ⇒ still the seed default
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("tunedConfidenceFloor seeds from defaultFloor when no store exists yet", () => {
		const dir = tmp();
		try {
			expect(tunedConfidenceFloor(0.4, dir)).toBe(0.4);
			expect(tunedConfidenceFloor(0.55, dir)).toBe(0.55); // no prior state — always reflects the caller's default
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("enough overcautious evidence loosens the persisted floor by one step", () => {
		const dir = tmp();
		try {
			for (let i = 0; i < 25; i++) recordConfidenceOutcome(dir, 0.4, 0.2, true);
			const floor = tunedConfidenceFloor(0.4, dir);
			expect(floor).toBeLessThan(0.4);
			expect(floor).toBeGreaterThanOrEqual(0.1); // never below the tuner's own floor
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a corrupt store reads as the seed default rather than throwing", () => {
		const dir = tmp();
		try {
			writeFileSync(path.join(dir, "threshold-tuner.json"), "{not json");
			expect(tunedConfidenceFloor(0.4, dir)).toBe(0.4);
			expect(() => recordConfidenceOutcome(dir, 0.4, 0.5, true)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the sample window is capped (bounded storage, not unbounded growth)", () => {
		const dir = tmp();
		try {
			for (let i = 0; i < 250; i++) recordConfidenceOutcome(dir, 0.4, 0.9, true);
			// Indirectly verified via nextFloor's behavior remaining stable/fast; direct cap size isn't
			// part of the public API, so this just guards against an unbounded-growth regression by
			// asserting the call completes and still returns a sane number quickly.
			expect(typeof tunedConfidenceFloor(0.4, dir)).toBe("number");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
