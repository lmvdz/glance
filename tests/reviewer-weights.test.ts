import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	MIN_FINDINGS_FOR_WEIGHT,
	parseReviewerLedger,
	readReviewerLedgerEntries,
	renderReviewerPrecision,
	renderReviewerReport,
	resetReviewerLedgerCacheForTests,
	reviewerLedgerReadCountForTests,
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
		const text = [JSON.stringify(row()), "", "{not json", JSON.stringify({ at: "2026-08-03", lineage: "codex" }), JSON.stringify(row({ source: "PR #1000", severity: "high" }))].join("\n");
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

	// ── gauntlet round 2 (delta-verify): round 1's dedup key regressed real data — 86 ledger rows
	// collapsed to 79, codex n 52→45, by merging genuinely distinct findings that happened to share
	// at+lineage+concernClass+source+survived. Corrected: only rows identical across EVERY field
	// (note/severity included, whitespace-normalized) collapse.

	test("REGRESSION FIX (gauntlet round 2): two rows sharing at+lineage+concernClass+source+survived but with DIFFERENT notes are genuinely distinct findings — BOTH must count", () => {
		const text = [JSON.stringify(row({ note: "the reviewer flagged issue A" })), JSON.stringify(row({ note: "the reviewer flagged a DIFFERENT issue B" }))].join("\n");
		const { entries, duplicates } = parseReviewerLedger(text);
		expect(entries.length).toBe(2);
		expect(duplicates).toBe(0);
		expect(entries.map((e) => e.note)).toEqual(["the reviewer flagged issue A", "the reviewer flagged a DIFFERENT issue B"]);
	});

	test("two rows sharing every field but differing in severity are genuinely distinct — severity is part of the finding, not commentary to ignore", () => {
		const text = [JSON.stringify(row({ severity: "low" })), JSON.stringify(row({ severity: "high" }))].join("\n");
		const { entries, duplicates } = parseReviewerLedger(text);
		expect(entries.length).toBe(2);
		expect(duplicates).toBe(0);
	});

	test("a row that is identical to another after trimming incidental whitespace (the true accidental-re-append case) still collapses to one", () => {
		const text = [JSON.stringify(row({ note: "finding" })), JSON.stringify(row({ note: "  finding  " }))].join("\n");
		const { entries, duplicates } = parseReviewerLedger(text);
		expect(entries.length).toBe(1);
		expect(duplicates).toBe(1);
	});

	test("rows that differ in ANY of the five tuple fields (at/lineage/concernClass/source/survived) are genuinely distinct", () => {
		const text = [JSON.stringify(row({ survived: true })), JSON.stringify(row({ survived: false }))].join("\n");
		const { entries, duplicates } = parseReviewerLedger(text);
		expect(entries.length).toBe(2);
		expect(duplicates).toBe(0);
	});

	test("REGRESSION FIX (gauntlet round 2): re-parsing the REAL committed ledger's pre-fix content returns codex n to 52", () => {
		// A frozen, verbatim snapshot of plans/.reviews/reviewer-ledger.jsonl taken BEFORE this round's
		// own campaign-bookkeeping rows were appended (tests/fixtures/reviewer-ledger-round2-regression-
		// snapshot.jsonl) — reading the LIVE ledger here would make this assertion drift every time a
		// legitimate future `add` grows the real file, which is not what this regression test is for.
		// Measured damage under round 1's broken key: 86 rows parsed to 79 entries, codex 52→45.
		const fixture = readFileSync(path.join(import.meta.dir, "fixtures", "reviewer-ledger-round2-regression-snapshot.jsonl"), "utf8");
		const { entries } = parseReviewerLedger(fixture);
		expect(entries.length).toBe(86); // no rows lost — round 1's over-collapse is fully undone
		const codexRows = entries.filter((e) => e.lineage === "codex");
		expect(codexRows.length).toBe(52);
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
		// toEqual/toBeUndefined alone can't tell "key absent" from "key present holding undefined"
		// (gauntlet round 1, codex: "survivedRate present-as-undefined") — assert ownership directly.
		expect(Object.hasOwn(stamp, "survivedRate")).toBe(false);
	});

	test("an empty ledger yields the same honest n=0 stamp — no priors, no smoothing", () => {
		const stamp = reviewerPrecisionFor([], "grok");
		expect(stamp).toEqual({ lineage: "grok", n: 0, survived: 0, provisional: true });
		expect(Object.hasOwn(stamp, "survivedRate")).toBe(false);
	});

	test("HONESTY (gauntlet round 1, codex): survivedRate is an OWNED key, not merely truthy, when n > 0", () => {
		const stamp = reviewerPrecisionFor([row()], "grok");
		expect(stamp.n).toBe(1);
		expect(Object.hasOwn(stamp, "survivedRate")).toBe(true);
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

	test("a MISSING ledger file degrades to no entries, never throws, and is NOT flagged unreadable (absence is normal)", () => {
		const result = readReviewerLedgerEntries("/nonexistent/path/reviewer-ledger.jsonl");
		expect(result.entries).toEqual([]);
		expect(result.rejected).toBe(0);
		expect(result.duplicates).toBe(0);
		expect(result.unreadable).toBeUndefined();
	});

	test("an EMPTY ledger file degrades to no entries", async () => {
		const file = await tmpLedger([]);
		const { entries } = readReviewerLedgerEntries(file);
		expect(entries).toEqual([]);
	});

	test("reviewerPrecisionFromLedger reads a real fixture file and computes real precision", async () => {
		// Distinct `source`s: at+lineage+concernClass+source+survived is the SEMANTIC identity
		// (gauntlet round 1) — a real multi-row fixture needs rows that differ in one of those five
		// fields, exactly like real ledger rows do (note/severity alone no longer distinguishes).
		const file = await tmpLedger([JSON.stringify(row({ source: "PR #1" })), JSON.stringify(row({ source: "PR #2" })), JSON.stringify(row({ survived: false, source: "PR #3" }))]);
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
		const file = await tmpLedger([JSON.stringify(row({ source: "PR #1" })), JSON.stringify(row({ source: "PR #2" }))]);
		const before = reviewerPrecisionFromLedger("grok", file);
		expect(before.n).toBe(2);
		expect(before.survivedRate).toBe(1);

		await fs.appendFile(file, `${JSON.stringify(row({ survived: false, source: "PR #3" }))}\n`);

		const after = reviewerPrecisionFromLedger("grok", file);
		expect(after.n).toBe(3);
		expect(after.survived).toBe(2);
		expect(after.survivedRate).toBeCloseTo(2 / 3);
		expect(after.n).not.toBe(before.n);
		expect(after.survivedRate).not.toBe(before.survivedRate);
	});

	// ── HIGH (gauntlet round 1, codex): partial-corrupt ledger ────────────────────────────────────────

	test("a MINOR corruption (a few malformed lines) still measures from the valid rows, flagged via `rejected`, not silently absorbed", async () => {
		const file = await tmpLedger([JSON.stringify(row({ source: "PR #1" })), "{not json", JSON.stringify(row({ source: "PR #2", survived: false })), JSON.stringify(row({ source: "PR #3" }))]);
		const stamp = reviewerPrecisionFromLedger("grok", file);
		expect(stamp.n).toBe(3);
		expect(stamp.survived).toBe(2);
		expect(stamp.rejected).toBe(1);
		expect(stamp.corrupt).toBeUndefined();
	});

	test("a MAJORITY-corrupt ledger degrades FULLY to unmeasured — not a confident number from a shrinking, unrepresentative subset", async () => {
		// 1 valid row, 5 malformed lines ⇒ 5/6 ≈ 83% rejected, well above the corrupt threshold.
		const file = await tmpLedger([JSON.stringify(row()), "{not json 1", "{not json 2", "{not json 3", "{not json 4", "{not json 5"]);
		const stamp = reviewerPrecisionFromLedger("grok", file);
		expect(stamp.n).toBe(0);
		expect(stamp.survived).toBe(0);
		expect(stamp.survivedRate).toBeUndefined();
		expect(stamp.corrupt).toBe(true);
		expect(stamp.rejected).toBe(5);
	});

	test("a single stray bad line among many good ones must NOT zero out real history (adjudicated fix: fraction-based, not any-corruption-zeroes)", async () => {
		const rows = Array.from({ length: 20 }, (_, i) => JSON.stringify(row({ source: `PR #${i}` })));
		const file = await tmpLedger([...rows, "{not json"]); // 1/21 ≈ 5% rejected — well below the threshold
		const stamp = reviewerPrecisionFromLedger("grok", file);
		expect(stamp.n).toBe(20);
		expect(stamp.corrupt).toBeUndefined();
		expect(stamp.rejected).toBe(1);
	});

	// ── HIGH (gauntlet round 1, grok): read-error must never read as absence ─────────────────────────

	test("a path that is NOT a regular file (e.g. a directory) is reported unreadable — distinct from an absent file, and never attempted as a blocking read", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-ledger-notafile-"));
		tmps.push(dir);
		const stamp = reviewerPrecisionFromLedger("grok", dir); // dir, not a file
		expect(stamp.n).toBe(0);
		expect(stamp.unreadable).toBeDefined();
		expect(stamp.unreadable).toContain("not a regular file");
	});

	test("readReviewerLedgerEntries surfaces the SAME unreadable distinction directly", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-ledger-notafile2-"));
		tmps.push(dir);
		const result = readReviewerLedgerEntries(dir);
		expect(result.entries).toEqual([]);
		expect(result.unreadable).toBeDefined();
	});
});

// ── gauntlet round 2 (delta-verify), "hot-path-full-ledger-reread": every non-skipped land resolution
// reads the ledger; without a cache, two cache-hit lands in a row meant two full readFileSync+parse
// passes over the whole file — an unbounded, event-loop-blocking cost as the ledger grows. The fix
// caches the parsed ledger per path, invalidated on (mtimeNs, size) — statSync still runs every call
// (cheap), so an append is still picked up on the VERY NEXT read (the freshness invariant is preserved).

describe("readReviewerLedgerEntries: mtime/size parsed-ledger cache", () => {
	const tmps: string[] = [];
	beforeEach(() => resetReviewerLedgerCacheForTests());
	afterEach(async () => {
		for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	});
	async function tmpLedger(lines: string[]): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-ledger-cache-"));
		tmps.push(dir);
		const file = path.join(dir, "reviewer-ledger.jsonl");
		await fs.writeFile(file, lines.map((l) => `${l}\n`).join(""));
		return file;
	}

	test("two resolutions of an UNCHANGED ledger perform exactly ONE real read+parse", async () => {
		const file = await tmpLedger([JSON.stringify(row({ source: "PR #1" }))]);
		readReviewerLedgerEntries(file);
		readReviewerLedgerEntries(file);
		readReviewerLedgerEntries(file);
		expect(reviewerLedgerReadCountForTests()).toBe(1);
	});

	test("appending a row causes the NEXT resolution to re-read — the freshness invariant survives the cache", async () => {
		const file = await tmpLedger([JSON.stringify(row({ source: "PR #1" }))]);
		readReviewerLedgerEntries(file);
		expect(reviewerLedgerReadCountForTests()).toBe(1);

		await fs.appendFile(file, `${JSON.stringify(row({ survived: false, source: "PR #2" }))}\n`);
		const afterAppend = readReviewerLedgerEntries(file);

		expect(reviewerLedgerReadCountForTests()).toBe(2);
		expect(afterAppend.entries.length).toBe(2);
	});

	test("FLIP THE INPUT still holds through the cache: reviewerPrecisionFromLedger's number moves after an append, and does not re-read for a repeated identical call in between", async () => {
		const file = await tmpLedger([JSON.stringify(row({ source: "PR #1" }))]);
		const before = reviewerPrecisionFromLedger("grok", file);
		const beforeAgain = reviewerPrecisionFromLedger("grok", file); // cache hit — no new read
		expect(before.n).toBe(1);
		expect(beforeAgain.n).toBe(1);
		expect(reviewerLedgerReadCountForTests()).toBe(1);

		await fs.appendFile(file, `${JSON.stringify(row({ survived: false, source: "PR #2" }))}\n`);
		const after = reviewerPrecisionFromLedger("grok", file);

		expect(after.n).toBe(2);
		expect(reviewerLedgerReadCountForTests()).toBe(2);
	});

	test("a MISSING or non-regular-file path never counts as a real read (statSync-only paths are free)", async () => {
		readReviewerLedgerEntries("/nonexistent/path/reviewer-ledger.jsonl");
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-ledger-cache-notafile-"));
		tmps.push(dir);
		readReviewerLedgerEntries(dir);
		expect(reviewerLedgerReadCountForTests()).toBe(0);
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

	// ── LOW (gauntlet round 1, grok): Math.round hides a tiny nonzero rate ───────────────────────────

	test("a true rate under 1% renders as '<1%', never as an indistinguishable '0%'", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 201, survived: 1, survivedRate: 1 / 201, provisional: false });
		expect(out).toContain("<1%");
		expect(out).not.toContain("0%");
	});

	test("an EXACT zero survivedRate still renders '0%' — real zero and near-zero stay distinguishable", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 50, survived: 0, survivedRate: 0, provisional: false });
		expect(out).toContain("0%");
		expect(out).not.toContain("<1%");
	});

	// ── MEDIUM (gauntlet round 1, codex): no fabricated 0% when the rate is genuinely missing ────────

	test("HONESTY: a stamp with n>0 but no survivedRate (a malformed wire value) renders unmeasured, never a fabricated 0%", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 5, survived: 2, provisional: true });
		expect(out).toContain("unmeasured");
		expect(out).not.toContain("0%");
	});

	// ── HIGH (gauntlet round 1, codex + grok): the two new degrade-to-unmeasured reasons render distinctly ──

	test("an unreadable ledger renders its OWN reason, distinct from plain 'unmeasured (n=0)'", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 0, survived: 0, provisional: true, unreadable: "EACCES: permission denied" });
		expect(out).toContain("unreadable");
		expect(out).toContain("permission denied");
		expect(out).not.toBe("grok, unmeasured (n=0)");
	});

	test("a too-corrupt-to-trust ledger renders its OWN reason, citing the unparseable count", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 0, survived: 0, provisional: true, corrupt: true, rejected: 9 });
		expect(out).toContain("too corrupt to trust");
		expect(out).toContain("9 unparseable rows");
	});

	test("a MINOR corruption still shows the measured number, with the unparseable count as a caveat", () => {
		const out = renderReviewerPrecision({ lineage: "grok", n: 20, survived: 20, survivedRate: 1, provisional: true, rejected: 1 });
		expect(out).toContain("measured precision 100%");
		expect(out).toContain("1 row unparseable");
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
