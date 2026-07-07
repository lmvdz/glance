import { expect, test } from "bun:test";
import { scoreConfidence } from "../src/confidence.ts";

test("fresh proof + few files touched → high confidence", () => {
	expect(scoreConfidence({ verificationState: "fresh", filesTouched: 1 })).toBeCloseTo(0.9);
});

test("failed proof + wide blast radius → clamped to 0", () => {
	expect(scoreConfidence({ verificationState: "failed", filesTouched: 20 })).toBe(0);
});

test("stale proof + mid-size blast radius → neutral 0.5", () => {
	expect(scoreConfidence({ verificationState: "stale", filesTouched: 5 })).toBeCloseTo(0.5);
});

test("validator absent never penalizes — same score as no validator arg at all", () => {
	const withoutValidator = scoreConfidence({ verificationState: "stale", filesTouched: 5 });
	const withUndefinedValidator = scoreConfidence({ verificationState: "stale", filesTouched: 5, validator: undefined });
	expect(withUndefinedValidator).toBe(withoutValidator);
});

test("validator fail drops the score below the no-validator baseline", () => {
	const baseline = scoreConfidence({ verificationState: "fresh", filesTouched: 1 });
	const withFail = scoreConfidence({ verificationState: "fresh", filesTouched: 1, validator: "fail" });
	expect(withFail).toBeLessThan(baseline);
});

test("validator pass raises the score above the no-validator baseline (unclamped case)", () => {
	const baseline = scoreConfidence({ verificationState: "stale", filesTouched: 5 });
	const withPass = scoreConfidence({ verificationState: "stale", filesTouched: 5, validator: "pass" });
	expect(withPass).toBeGreaterThan(baseline);
});

test("score is always clamped to [0,1]", () => {
	expect(scoreConfidence({ verificationState: "fresh", filesTouched: 1, validator: "pass" })).toBeLessThanOrEqual(1);
	expect(scoreConfidence({ verificationState: "none", filesTouched: 999, validator: "fail" })).toBeGreaterThanOrEqual(0);
});

test("unknown verification state is treated the same as none/failed (never a bonus)", () => {
	expect(scoreConfidence({ verificationState: "unknown", filesTouched: 5 })).toBe(scoreConfidence({ verificationState: "none", filesTouched: 5 }));
});

test("same-lineage pass earns a smaller bonus than a cross-lineage pass", () => {
	const cross = scoreConfidence({ verificationState: "stale", filesTouched: 5, validator: "pass", sameLineage: false });
	const same = scoreConfidence({ verificationState: "stale", filesTouched: 5, validator: "pass", sameLineage: true });
	expect(same).toBeCloseTo(cross - 0.05);
});

test("sameLineage undefined preserves the exact prior pass behavior", () => {
	const prior = scoreConfidence({ verificationState: "stale", filesTouched: 5, validator: "pass" });
	const undef = scoreConfidence({ verificationState: "stale", filesTouched: 5, validator: "pass", sameLineage: undefined });
	expect(undef).toBe(prior);
});

test("a same-lineage veto is not softened — still the full -0.4", () => {
	const cross = scoreConfidence({ verificationState: "fresh", filesTouched: 1, validator: "fail", sameLineage: false });
	const same = scoreConfidence({ verificationState: "fresh", filesTouched: 1, validator: "fail", sameLineage: true });
	expect(same).toBe(cross);
});
