import { afterEach, describe, expect, test } from "bun:test";
import type { LensId } from "../src/lens-select.ts";
import type { FeatureCriterion } from "../src/types.ts";
import type { Judge, LensJudge } from "../src/validator.ts";
import { runLensPanel, scoreAgainstCriteria, validatorGate } from "../src/validator.ts";

/** A lens-judge factory, matching what runLensPanel / validatorGate consume. */
type Make = (l: LensId) => LensJudge;

// Concern-03 wiring. The lens LOGIC (selection, fail-open, aggregation) is tested directly via
// runLensPanel — that avoids fighting computeLandDiff's git dependency. validatorGate is tested only on
// the diff-independent paths (flag off, validator disabled). The "a lens never vetoes" invariant is
// proved structurally: runLensPanel returns LensVerdict[] only; validatorGate's veto comes solely from
// the criteria judge (scoreAgainstCriteria), which never reads lensAdvisory.

const repo = process.cwd();
const SRC_DIFF = "diff --git a/src/thing.ts b/src/thing.ts\n@@ -1 +1 @@\n-a\n+b";
const DOCS_DIFF = "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-a\n+b";

const objectLens = (severity: "low" | "high"): Make => () => async ({ lens }) => ({ lens, disposition: "object", severity, claim: "problem" });
const acceptLens: Make = () => async ({ lens }) => ({ lens, disposition: "accept", severity: "low", claim: "" });
const throwingLens: Make = () => async () => {
	throw new Error("lens exploded");
};
const undefinedLens: Make = () => async () => undefined;

afterEach(() => {
	delete process.env.OMP_SQUAD_LENS_REVIEW;
	delete process.env.OMP_SQUAD_LENS_MAX;
	delete process.env.OMP_SQUAD_VALIDATOR;
});

describe("runLensPanel (fail-open + aggregation)", () => {
	test("a throwing lens yields NO signal — the panel resolves [], never rejects (fail-open)", async () => {
		const out = await runLensPanel(SRC_DIFF, undefined, "", throwingLens);
		expect(out).toEqual([]);
	});

	test("an undefined-returning lens (timeout/garbage proxy) yields []", async () => {
		expect(await runLensPanel(SRC_DIFF, undefined, "", undefinedLens)).toEqual([]);
	});

	test("an objecting lens is collected", async () => {
		const out = await runLensPanel(SRC_DIFF, undefined, "", objectLens("high"));
		expect(out).toEqual([{ lens: "regression", disposition: "object", severity: "high", claim: "problem" }]);
	});

	test("docs-only diff selects no lens ⇒ [] without invoking the judge", async () => {
		let called = 0;
		const spy: Make = () => async () => {
			called++;
			return undefined;
		};
		expect(await runLensPanel(DOCS_DIFF, undefined, "", spy)).toEqual([]);
		expect(called).toBe(0);
	});

	test("an accepting lens contributes a verdict (clean signal, not an objection)", async () => {
		const out = await runLensPanel(SRC_DIFF, undefined, "", acceptLens);
		expect(out).toEqual([{ lens: "regression", disposition: "accept", severity: "low", claim: "" }]);
	});
});

describe("validatorGate lens gating", () => {
	test("master flag OFF ⇒ lens judge never invoked, no lensAdvisory", async () => {
		let called = 0;
		const lensJudge = () => (async () => {
			called++;
			return undefined;
		}) as LensJudge;
		const { record } = await validatorGate({ criteria: [{ id: "c1", text: "x", completed: false }], repo, worktree: repo, judge: (async ({ criteria }) => ({ perCriterion: criteria.map((c) => ({ id: c.id, satisfied: true })) })) as Judge, lensJudge });
		expect(called).toBe(0);
		expect(record.lensAdvisory).toBeUndefined();
	});

	test("validator disabled ⇒ skipped, lens never consulted even with master flag on", async () => {
		process.env.OMP_SQUAD_LENS_REVIEW = "1";
		process.env.OMP_SQUAD_VALIDATOR = "0";
		let called = 0;
		const lensJudge = () => (async () => {
			called++;
			return undefined;
		}) as LensJudge;
		const { record } = await validatorGate({ criteria: [{ id: "c1", text: "x", completed: false }], repo, worktree: repo, lensJudge });
		expect(record.verdict).toBe("skipped");
		expect(called).toBe(0);
	});
});

describe("a lens never drives the veto", () => {
	test("scoreAgainstCriteria (the veto source) ignores lenses entirely; veto ⇐ unsatisfied criteria only", async () => {
		const criteria: FeatureCriterion[] = [{ id: "c1", text: "x", completed: false }];
		const vetoRec = await scoreAgainstCriteria(criteria, SRC_DIFF, undefined, async ({ criteria: cs }) => ({ perCriterion: cs.map((c) => ({ id: c.id, satisfied: false })) }));
		expect(vetoRec.verdict).toBe("veto");
		expect(vetoRec.lensAdvisory).toBeUndefined(); // the scorer has no lens concept
	});
});
