/**
 * Validator core (Epic 3, leaf 01) — `scoreAgainstCriteria` scored against a FAKE judge (no real
 * `omp`). Covers the four DESIGN-frozen outcomes: pass (all criteria satisfied), veto (a weak
 * self-authored proof passes but a declared criterion is missed), abstain (judge unavailable), and
 * skipped (no declared criteria).
 */

import { expect, test } from "bun:test";
import { type RawVerdict, scoreAgainstCriteria } from "../src/validator.ts";
import type { FeatureCriterion } from "../src/types.ts";

const CRITERIA: FeatureCriterion[] = [
	{ id: "c1", text: "adds a /api/widgets endpoint", completed: false },
	{ id: "c2", text: "the endpoint is authenticated", completed: false },
];

function fakeJudge(verdict: RawVerdict | undefined): () => Promise<RawVerdict | undefined> {
	return async () => verdict;
}

test("all declared criteria satisfied ⇒ pass, agreement 1", async () => {
	const judge = fakeJudge({
		perCriterion: [
			{ id: "c1", satisfied: true },
			{ id: "c2", satisfied: true },
		],
		confidence: 0.9,
		rationale: "both criteria are visibly implemented in the diff",
	});
	const result = await scoreAgainstCriteria(CRITERIA, "diff content", undefined, judge);
	expect(result.verdict).toBe("pass");
	expect(result.agreement).toBe(1);
	expect(result.confidence).toBe(0.9);
	expect(result.perCriterion).toEqual([
		{ id: "c1", satisfied: true, note: undefined },
		{ id: "c2", satisfied: true, note: undefined },
	]);
});

test("a weak self-authored test passes but a declared criterion is missed ⇒ veto, agreement < 1", async () => {
	// The diff includes a passing test for c1, but the judge — reading the DECLARED criteria, not the
	// author's own test — finds c2 (auth) unimplemented.
	const judge = fakeJudge({
		perCriterion: [
			{ id: "c1", satisfied: true, note: "endpoint exists and the author's test covers it" },
			{ id: "c2", satisfied: false, note: "no auth check anywhere in the diff" },
		],
		confidence: 0.85,
		rationale: "endpoint added but unauthenticated — fails the declared criterion",
	});
	const result = await scoreAgainstCriteria(CRITERIA, "diff with only a happy-path test", undefined, judge);
	expect(result.verdict).toBe("veto");
	expect(result.agreement).toBe(0.5);
	expect(result.perCriterion.find((p) => p.id === "c2")?.satisfied).toBe(false);
});

test("an unmentioned criterion defaults to unsatisfied (never silently passes)", async () => {
	const judge = fakeJudge({ perCriterion: [{ id: "c1", satisfied: true }] }); // c2 never mentioned
	const result = await scoreAgainstCriteria(CRITERIA, "diff", undefined, judge);
	expect(result.verdict).toBe("veto");
	expect(result.perCriterion.find((p) => p.id === "c2")).toEqual({ id: "c2", satisfied: false, note: undefined });
});

test("judge returns undefined (unreachable/unparseable) ⇒ abstain, fail-open", async () => {
	const result = await scoreAgainstCriteria(CRITERIA, "diff", undefined, fakeJudge(undefined));
	expect(result.verdict).toBe("abstain");
	expect(result.confidence).toBe(0);
});

test("a throwing judge is treated the same as undefined ⇒ abstain, never throws", async () => {
	const judge = async (): Promise<RawVerdict | undefined> => {
		throw new Error("omp spawn exploded");
	};
	const result = await scoreAgainstCriteria(CRITERIA, "diff", undefined, judge);
	expect(result.verdict).toBe("abstain");
});

test("empty declared criteria ⇒ skipped, never invents criteria to grade against", async () => {
	const judge = fakeJudge({ perCriterion: [{ id: "c1", satisfied: false }] }); // must not even be called meaningfully
	const result = await scoreAgainstCriteria([], "diff", undefined, judge);
	expect(result.verdict).toBe("skipped");
	expect(result.agreement).toBe(1);
	expect(result.perCriterion).toEqual([]);
});

test("empty diff ⇒ abstain and the judge is never called (no fabricated veto for a change it never saw)", async () => {
	// Regression for the in-place (worktree === repo) empty-diff bug: the base collapses to HEAD, so the
	// judge would otherwise be handed an empty diff with real criteria and mark them unmet ⇒ a fabricated
	// veto. An empty diff must abstain (fail-open) without ever invoking the judge.
	let called = false;
	const judge = async (): Promise<RawVerdict | undefined> => {
		called = true;
		return { perCriterion: [{ id: "c1", satisfied: false }, { id: "c2", satisfied: false }], rationale: "would veto" };
	};
	for (const diff of ["", "   \n\t  "]) {
		const result = await scoreAgainstCriteria(CRITERIA, diff, undefined, judge);
		expect(result.verdict).toBe("abstain");
		expect(result.verdict).not.toBe("veto");
	}
	expect(called).toBe(false);
});

test("rationale is truncated to ~600 chars", async () => {
	const judge = fakeJudge({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }], rationale: "x".repeat(900) });
	const result = await scoreAgainstCriteria(CRITERIA, "diff", undefined, judge);
	expect(result.rationale.length).toBeLessThanOrEqual(601); // 600 + ellipsis
});
