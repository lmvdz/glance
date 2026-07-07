import { describe, expect, test } from "bun:test";
import { lensAdvisoryBucket, scoreConfidence } from "./confidence.ts";
import type { LensVerdict, ValidationRecord } from "./types.ts";

// Base scenario chosen to sit mid-range (0.5) so lens deltas are visible, not clamped:
// verificationState "stale" (+0), filesTouched 5 (0), no primary validator.
const base = { verificationState: "stale" as const, filesTouched: 5 };

describe("scoreConfidence lens deltas (advisory, sub-primary magnitude)", () => {
	test("absent lensAdvisory ⇒ neutral (unchanged from base)", () => {
		expect(scoreConfidence(base)).toBeCloseTo(0.5, 5);
		expect(scoreConfidence({ ...base, lensAdvisory: undefined })).toBeCloseTo(0.5, 5);
	});
	test("clean +0.05", () => {
		expect(scoreConfidence({ ...base, lensAdvisory: "clean" })).toBeCloseTo(0.55, 5);
	});
	test("objected −0.15", () => {
		expect(scoreConfidence({ ...base, lensAdvisory: "objected" })).toBeCloseTo(0.35, 5);
	});
	test("confirmed −0.25", () => {
		expect(scoreConfidence({ ...base, lensAdvisory: "confirmed" })).toBeCloseTo(0.25, 5);
	});
	test("every lens delta is smaller in magnitude than the primary validator's veto (−0.4)", () => {
		for (const b of ["clean", "objected", "confirmed"] as const) {
			const delta = Math.abs(scoreConfidence({ ...base, lensAdvisory: b }) - 0.5);
			expect(delta).toBeLessThan(0.4);
		}
	});
	test("result stays within [0,1] when a lens penalty stacks with other penalties", () => {
		// fresh(+0.3) ... but push low: failed verification (−0.3) + many files (−0.2) + veto (−0.4) + confirmed (−0.25)
		const low = scoreConfidence({ verificationState: "failed", filesTouched: 30, validator: "fail", lensAdvisory: "confirmed" });
		expect(low).toBeGreaterThanOrEqual(0);
		expect(low).toBeLessThanOrEqual(1);
		// and a clean bonus stacked on a high base can't exceed 1
		const high = scoreConfidence({ verificationState: "fresh", filesTouched: 1, validator: "pass", sameLineage: false, lensAdvisory: "clean" });
		expect(high).toBeLessThanOrEqual(1);
	});
});

describe("lensAdvisoryBucket", () => {
	const rec = (lensAdvisory?: LensVerdict[], lensVerify?: ValidationRecord["lensVerify"]): ValidationRecord => ({
		verdict: "pass",
		agreement: 1,
		confidence: 1,
		perCriterion: [],
		rationale: "",
		ranAt: 0,
		lensAdvisory,
		lensVerify,
	});
	const v = (disposition: "accept" | "object", severity: "low" | "high" = "low"): LensVerdict => ({ lens: "regression", disposition, severity, claim: "x" });

	test("no record / no lenses ⇒ undefined (neutral)", () => {
		expect(lensAdvisoryBucket(undefined)).toBeUndefined();
		expect(lensAdvisoryBucket(rec(undefined))).toBeUndefined();
		expect(lensAdvisoryBucket(rec([]))).toBeUndefined();
	});
	test("all accept ⇒ clean", () => {
		expect(lensAdvisoryBucket(rec([v("accept"), v("accept")]))).toBe("clean");
	});
	test("any objection ⇒ objected", () => {
		expect(lensAdvisoryBucket(rec([v("accept"), v("object", "high")]))).toBe("objected");
	});
	test("a confirmed re-check outranks a plain objection ⇒ confirmed", () => {
		expect(lensAdvisoryBucket(rec([v("object", "high")], { lens: "regression", claim: "x", confirmed: true }))).toBe("confirmed");
	});
	test("an UNconfirmed re-check stays 'objected'", () => {
		expect(lensAdvisoryBucket(rec([v("object", "high")], { lens: "regression", claim: "x", confirmed: false }))).toBe("objected");
	});
});
