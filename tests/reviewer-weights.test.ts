import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	MIN_FINDINGS_FOR_WEIGHT,
	parseReviewerLedger,
	readReviewerLedgerEntries,
	renderReviewerPrecision,
	renderReviewerReport,
	reviewerPrecision,
	reviewerPrecisionFor,
	reviewerPrecisionFromLedger,
	type ReviewerLedgerEntry,
} from "../src/memory/reviewer-weights.ts";

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

// ── glance#332: the land-path moat centerpiece — consumable precision reader + honesty rules ───────

describe("reviewerPrecisionFor", () => {
	test("computes {n, survived, survivedRate} for a lineage with real history — the fixture-ledger math", () => {
		const entries = [...Array.from({ length: 3 }, () => row()), row({ survived: false })];
		const stamp = reviewerPrecisionFor(entries, "grok");
		expect(stamp.lineage).toBe("grok");
		expect(stamp.n).toBe(4);
		expect(stamp.survived).toBe(3);
		expect(stamp.survivedRate).toBeCloseTo(0.75);
		expect(stamp.provisional).toBeTrue(); // below MIN_FINDINGS_FOR_WEIGHT
	});

	test("provisional clears at the evidence floor, mirroring reviewerPrecision's own floor", () => {
		const entries = Array.from({ length: MIN_FINDINGS_FOR_WEIGHT }, () => row());
		expect(reviewerPrecisionFor(entries, "grok").provisional).toBeFalse();
		expect(reviewerPrecisionFor(entries.slice(1), "grok").provisional).toBeTrue();
	});

	test("HONESTY: a lineage with zero adjudicated rows renders n=0 with NO survivedRate — never a fabricated or smoothed number", () => {
		const stamp = reviewerPrecisionFor([row({ lineage: "codex" })], "never-reviewed-lineage");
		expect(stamp.n).toBe(0);
		expect(stamp.survived).toBe(0);
		expect(stamp.survivedRate).toBeUndefined();
		expect(stamp.provisional).toBeTrue();
	});

	test("an empty ledger yields the same honest n=0 stamp — no priors, no smoothing", () => {
		const stamp = reviewerPrecisionFor([], "grok");
		expect(stamp).toEqual({ lineage: "grok", n: 0, survived: 0, survivedRate: undefined, provisional: true });
	});
});

describe("readReviewerLedgerEntries + reviewerPrecisionFromLedger (file boundary)", () => {
	const tmps: string[] = [];
	afterEach(async () => {
		for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	});
	async function tmpLedger(lines: string[]): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-ledger-fixture-"));
		tmps.push(dir);
		const file = path.join(dir, "reviewer-ledger.jsonl");
		await fs.writeFile(file, lines.map((l) => `${l}\n`).join(""));
		return file;
	}

	test("a MISSING ledger file degrades to no entries, never throws", () => {
		const { entries, rejected, duplicates } = readReviewerLedgerEntries("/nonexistent/path/reviewer-ledger.jsonl");
		expect(entries).toEqual([]);
		expect(rejected).toBe(0);
		expect(duplicates).toBe(0);
	});

	test("an EMPTY ledger file degrades to no entries", async () => {
		const file = await tmpLedger([]);
		const { entries } = readReviewerLedgerEntries(file);
		expect(entries).toEqual([]);
	});

	test("reviewerPrecisionFromLedger reads a real fixture file and computes real precision", async () => {
		// Distinct `note`s: parseReviewerLedger treats BYTE-IDENTICAL lines as a retried `add` and
		// collapses them (by design — see the "REGRESSION (codex finding)" test above), so a real
		// multi-row fixture needs rows that genuinely differ, exactly like real ledger rows do.
		const file = await tmpLedger([JSON.stringify(row({ note: "finding one" })), JSON.stringify(row({ note: "finding two" })), JSON.stringify(row({ survived: false, note: "finding three" }))]);
		const stamp = reviewerPrecisionFromLedger("grok", file);
		expect(stamp.n).toBe(3);
		expect(stamp.survived).toBe(2);
		expect(stamp.survivedRate).toBeCloseTo(2 / 3);
	});

	test("a lineage absent from a real fixture ledger is honestly unmeasured, not a fabricated 0", async () => {
		const file = await tmpLedger([JSON.stringify(row({ lineage: "codex" }))]);
		const stamp = reviewerPrecisionFromLedger("native", file);
		expect(stamp.n).toBe(0);
		expect(stamp.survivedRate).toBeUndefined();
	});

	test("FLIP THE INPUT: appending a fixture ledger row MOVES the computed number — this is a live read, not a cached snapshot", async () => {
		const file = await tmpLedger([JSON.stringify(row({ note: "finding one" })), JSON.stringify(row({ note: "finding two" }))]);
		const before = reviewerPrecisionFromLedger("grok", file);
		expect(before.n).toBe(2);
		expect(before.survivedRate).toBe(1);

		await fs.appendFile(file, `${JSON.stringify(row({ survived: false, note: "a new adjudicated finding" }))}\n`);

		const after = reviewerPrecisionFromLedger("grok", file);
		expect(after.n).toBe(3);
		expect(after.survived).toBe(2);
		expect(after.survivedRate).toBeCloseTo(2 / 3);
		expect(after.n).not.toBe(before.n);
		expect(after.survivedRate).not.toBe(before.survivedRate);
	});
});

describe("renderReviewerPrecision", () => {
	test("renders a measured lineage with its n and percentage", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 28, survived: 21, survivedRate: 0.75, provisional: false });
		expect(out).toBe("grok, measured precision 75% (n=28 adjudicated rows)");
	});

	test("HONESTY: renders n=0 as unmeasured, never as a 0%-precision claim", () => {
		const out = renderReviewerPrecision({ lineage: "brand-new-lineage", n: 0, survived: 0, provisional: true });
		expect(out).toBe("brand-new-lineage, unmeasured (n=0)");
		expect(out).not.toContain("0%");
	});

	test("tags a provisional (below-floor) lineage", () => {
		const out = renderReviewerPrecision({ lineage: "native", n: 6, survived: 6, survivedRate: 1, provisional: true });
		expect(out).toContain("[provisional]");
	});

	test("scrubs control characters from a hand-edited lineage tag (mirrors renderReviewerReport's hardening)", () => {
		const out = renderReviewerPrecision({ lineage: "grok\n native: 99%", n: 0, survived: 0, provisional: true });
		expect(out).not.toContain("\n native");
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
