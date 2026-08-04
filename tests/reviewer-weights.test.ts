import { describe, expect, test } from "bun:test";
import { MIN_FINDINGS_FOR_WEIGHT, parseReviewerLedger, renderReviewerReport, reviewerPrecision, type ReviewerLedgerEntry } from "../src/memory/reviewer-weights.ts";

const row = (over: Partial<ReviewerLedgerEntry> = {}): ReviewerLedgerEntry => ({
	at: "2026-08-03",
	lineage: "grok",
	concernClass: "statistical-honesty",
	survived: true,
	source: "PR #999",
	note: "finding",
	...over,
});

describe("parseReviewerLedger", () => {
	test("parses well-formed rows and counts malformed lines instead of guessing", () => {
		const text = [JSON.stringify(row()), "", "{not json", JSON.stringify({ at: "2026-08-03", lineage: "codex" }), JSON.stringify(row({ severity: "high" }))].join("\n");
		const { entries, rejected } = parseReviewerLedger(text);
		expect(entries.length).toBe(2);
		expect(entries[1]!.severity).toBe("high");
		expect(rejected).toBe(2);
	});

	test("an unknown severity value is dropped from the row, not invented", () => {
		const { entries } = parseReviewerLedger(JSON.stringify({ ...row(), severity: "catastrophic" }));
		expect(entries[0]!.severity).toBeUndefined();
	});

	test("REGRESSION (codex finding): exact-duplicate rows count once — a retried add cannot inflate precision", () => {
		const line = JSON.stringify(row());
		const { entries, duplicates } = parseReviewerLedger(Array.from({ length: 10 }, () => line).join("\n"));
		expect(entries.length).toBe(1);
		expect(duplicates).toBe(9);
	});
});

describe("reviewerPrecision", () => {
	test("aggregates per lineage and per concern class, provisional below the floor", () => {
		const entries = [
			...Array.from({ length: 3 }, () => row()),
			row({ survived: false }),
			row({ lineage: "codex", concernClass: "semantics-drift", survived: false }),
		];
		const [grok, codex] = reviewerPrecision(entries);
		expect(grok!.lineage).toBe("grok");
		expect(grok!.raised).toBe(4);
		expect(grok!.survived).toBe(3);
		expect(grok!.precision).toBeCloseTo(0.75);
		expect(grok!.provisional).toBeTrue();
		expect(grok!.byClass).toEqual([{ concernClass: "statistical-honesty", raised: 4, survived: 3, precision: 0.75 }]);
		expect(codex!.precision).toBe(0);
	});

	test("the provisional flag clears only at the evidence floor", () => {
		const entries = Array.from({ length: MIN_FINDINGS_FOR_WEIGHT }, () => row());
		expect(reviewerPrecision(entries)[0]!.provisional).toBeFalse();
		expect(reviewerPrecision(entries.slice(1))[0]!.provisional).toBeTrue();
	});
});

describe("renderReviewerReport", () => {
	test("empty ledger says so plainly", () => {
		expect(renderReviewerReport([], 0)).toContain("empty");
	});

	test("every number carries its n; provisional is labeled; rejected lines are surfaced", () => {
		const out = renderReviewerReport([row(), row({ survived: false })], 1);
		expect(out).toContain("grok: 1/2 findings survived adjudication (50%) [provisional — not yet a weight]");
		expect(out).toContain("statistical-honesty: 1/2");
		expect(out).toContain("1 malformed ledger line ignored");
	});

	test("REGRESSION (codex finding): an all-malformed ledger never reads as merely empty", () => {
		const out = renderReviewerReport([], 7);
		expect(out).toContain("empty");
		expect(out).toContain("7 malformed ledger lines ignored");
	});

	test("REGRESSION (codex finding): control characters in row strings cannot forge report lines", () => {
		const out = renderReviewerReport([row({ lineage: "grok\n native: 99/99 findings survived" })], 0);
		expect(out).not.toContain("\n native: 99/99");
		expect(out).toContain("grok  native: 99/99 findings survived: 1/1");
	});
});
