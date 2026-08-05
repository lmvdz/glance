/**
 * Dogfood-window counter (landing-rail #339). The load-bearing property is the honesty invariant
 * every gauntlet round enforced: a land with no measured reviewer precision must NEVER count as
 * evidence, and an unmeasurable index must NEVER read as an empty one. Every test flips exactly one
 * input and asserts the count moves (or, for the honesty cases, that it does NOT move the wrong way).
 */

import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
	readLandReceiptIndex,
	landsByDay,
	measuredLandsByDay,
	isMeasuredLand,
	landMetricsWindow,
	utcDayOf,
} from "../src/rail/land-metrics.ts";
import { writeLandReceipt, landReceiptIndexRow, landReceiptIndexPath } from "../src/rail/index.ts";
import type { LandReceipt, LandReceiptIndexRow } from "../src/rail/index.ts";
import type { ValidationRecord } from "../src/types.ts";
import type { ReviewerPrecisionStamp } from "../src/memory/index.ts";

const measured: ReviewerPrecisionStamp = { lineage: "codex", n: 52, survived: 39, survivedRate: 39 / 52, provisional: false };
const unmeasured: ReviewerPrecisionStamp = { lineage: "grok", n: 0, survived: 0, provisional: true };

function validation(precision?: ReviewerPrecisionStamp): ValidationRecord {
	return { verdict: "pass", agreement: 1, confidence: 0.9, perCriterion: [{ id: "c1", satisfied: true }], rationale: "ok", model: precision?.lineage ?? "codex", reviewerPrecision: precision, ranAt: 1_700_000_000_000 };
}

// A day at UTC noon so the ms→UTC-day bucketing is unambiguous.
const DAY = (iso: string): number => Date.parse(`${iso}T12:00:00.000Z`);

function receipt(over: Partial<LandReceipt> = {}): LandReceipt {
	return {
		repo: "lmvdz/glance",
		branch: "rail/x",
		commit: "abc1234",
		files: ["a.ts"],
		landed: true,
		at: DAY("2026-08-04"),
		gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false },
		validation: validation(measured),
		forcedWithoutProof: false,
		cost: { costUnknown: true },
		...over,
	};
}

/** A bare index row (bypasses the receipt shape) for the parser/counter unit tests. */
function row(over: Partial<LandReceiptIndexRow> = {}): LandReceiptIndexRow {
	return { at: DAY("2026-08-04"), repo: "lmvdz/glance", branch: "rail/x", landed: true, forced: false, gateStatus: "green", precision: { lineage: "codex", n: 52, survived: 39 }, ...over };
}

describe("landReceiptIndexRow (the pure builder)", () => {
	test("carries precision ONLY when a validator stamped a lineage — absent validator ⇒ no precision key", () => {
		expect(landReceiptIndexRow(receipt({ validation: validation(measured) })).precision).toEqual({ lineage: "codex", n: 52, survived: 39 });
		// flip: drop the validation → the precision key must vanish, not become a zero object
		const r = landReceiptIndexRow(receipt({ validation: undefined }));
		expect(Object.hasOwn(r, "precision")).toBe(false);
	});

	test("n=0 validator is carried faithfully as n=0 (unmeasured), never omitted or coerced", () => {
		const r = landReceiptIndexRow(receipt({ validation: validation(unmeasured) }));
		expect(r.precision).toEqual({ lineage: "grok", n: 0, survived: 0 });
	});

	test("landed + forced flow straight from the receipt", () => {
		const r = landReceiptIndexRow(receipt({ landed: false, forcedWithoutProof: true, commit: undefined }));
		expect(r.landed).toBe(false);
		expect(r.forced).toBe(true);
		expect(Object.hasOwn(r, "commit")).toBe(false);
	});
});

describe("isMeasuredLand (the evidence predicate)", () => {
	test("landed ∧ precision.n>0 ⇒ evidence", () => {
		expect(isMeasuredLand(row())).toBe(true);
	});
	test("flip landed→false ⇒ NOT evidence (a rejected land is not a self-land)", () => {
		expect(isMeasuredLand(row({ landed: false }))).toBe(false);
	});
	test("flip n→0 ⇒ NOT evidence (unmeasured is not a measured zero)", () => {
		expect(isMeasuredLand(row({ precision: { lineage: "codex", n: 0, survived: 0 } }))).toBe(false);
	});
	test("flip precision→absent ⇒ NOT evidence", () => {
		expect(isMeasuredLand(row({ precision: undefined }))).toBe(false);
	});
});

describe("by-day counting", () => {
	test("landsByDay counts merges per UTC day; measuredLandsByDay is the n>0 subset", () => {
		const rows = [
			row({ at: DAY("2026-08-04") }), // measured
			row({ at: DAY("2026-08-04"), precision: undefined }), // landed, unmeasured
			row({ at: DAY("2026-08-05") }), // measured
			row({ at: DAY("2026-08-05"), landed: false }), // not landed
		];
		expect(landsByDay(rows)).toEqual({ "2026-08-04": 2, "2026-08-05": 1 });
		expect(measuredLandsByDay(rows)).toEqual({ "2026-08-04": 1, "2026-08-05": 1 });
	});
});

describe("landMetricsWindow (pure over rows + now)", () => {
	const now = DAY("2026-08-10");
	test("7-day window includes the boundary day and excludes the day before it", () => {
		const read = { rows: [row({ at: DAY("2026-08-04") }), row({ at: DAY("2026-08-03") })], malformed: 0 };
		const w = landMetricsWindow(read, 7, now); // since = 2026-08-04
		expect(w.sinceDay).toBe("2026-08-04");
		expect(w.untilDay).toBe("2026-08-10");
		expect(w.lands).toBe(1); // 08-03 is outside
		expect(w.measured).toBe(1);
	});

	test("measured vs unmeasured vs measuredDays, and malformed carried through", () => {
		const read = {
			rows: [
				row({ at: DAY("2026-08-05") }), // measured, day A
				row({ at: DAY("2026-08-05"), precision: undefined }), // unmeasured, day A
				row({ at: DAY("2026-08-06") }), // measured, day B
				row({ at: DAY("2026-08-06"), landed: false }), // not landed → not counted at all
			],
			malformed: 2,
		};
		const w = landMetricsWindow(read, 7, now);
		expect(w.lands).toBe(3);
		expect(w.measured).toBe(2);
		expect(w.unmeasured).toBe(1);
		expect(w.measuredDays).toBe(2); // two DISTINCT days had a measured land
		expect(w.malformed).toBe(2); // count is a floor, and says so
	});

	test("flip a row's n from 52→0 and the measured count drops by one (mutation is used, not just present)", () => {
		const base = { rows: [row({ at: DAY("2026-08-08") })], malformed: 0 };
		expect(landMetricsWindow(base, 7, now).measured).toBe(1);
		const flipped = { rows: [row({ at: DAY("2026-08-08"), precision: { lineage: "codex", n: 0, survived: 0 } })], malformed: 0 };
		expect(landMetricsWindow(flipped, 7, now).measured).toBe(0);
	});
});

describe("readLandReceiptIndex (the I/O boundary)", () => {
	// Create the state dir AND its land-receipts/ subdir, so tests can write the index file directly.
	// The index FILE stays absent until a test writes it, so the ENOENT "missing index" case still holds.
	const mkStateDir = () => {
		const d = mkdtempSync(join(tmpdir(), "landmetrics-"));
		mkdirSync(dirname(landReceiptIndexPath(d)), { recursive: true });
		return d;
	};

	test("missing index ⇒ honest empty (ENOENT is 'no lands yet', not an error)", async () => {
		const read = await readLandReceiptIndex(mkStateDir());
		expect(read).toEqual({ rows: [], malformed: 0 });
	});

	test("valid rows parse; malformed / shape-invalid lines are counted, never absorbed", async () => {
		const stateDir = mkStateDir();
		const idx = landReceiptIndexPath(stateDir);
		writeFileSync(idx, ""); // ensure dir exists via the write below
		appendFileSync(idx, JSON.stringify(row({ at: DAY("2026-08-04") })) + "\n");
		appendFileSync(idx, "not json\n");
		appendFileSync(idx, JSON.stringify({ repo: "x", branch: "y", landed: true }) + "\n"); // missing `at`
		appendFileSync(idx, JSON.stringify({ at: 123, repo: "x", branch: "y" }) + "\n"); // missing `landed`
		appendFileSync(idx, "\n"); // blank — skipped, not malformed
		const read = await readLandReceiptIndex(stateDir);
		expect(read.rows.length).toBe(1);
		expect(read.malformed).toBe(3);
	});

	test("a malformed precision object drops to unmeasured — never inflates the measured count", async () => {
		const stateDir = mkStateDir();
		const idx = landReceiptIndexPath(stateDir);
		writeFileSync(idx, JSON.stringify({ at: DAY("2026-08-04"), repo: "r", branch: "b", landed: true, forced: false, gateStatus: "green", precision: { lineage: "codex" } }) + "\n");
		const read = await readLandReceiptIndex(stateDir);
		expect(read.rows.length).toBe(1);
		expect(read.rows[0].precision).toBeUndefined(); // malformed stamp → unmeasured
		expect(isMeasuredLand(read.rows[0])).toBe(false);
	});

	test("a real (non-ENOENT) read error THROWS — an unreadable index is unmeasurable, never empty", async () => {
		const stateDir = mkStateDir();
		const idx = landReceiptIndexPath(stateDir);
		writeFileSync(idx, JSON.stringify(row()) + "\n");
		chmodSync(idx, 0o000); // unreadable
		let threw = false;
		try {
			await readLandReceiptIndex(stateDir);
		} catch {
			threw = true;
		} finally {
			chmodSync(idx, 0o644);
		}
		// Running as root ignores mode bits; only assert the throw when the chmod actually bites.
		if (process.getuid && process.getuid() !== 0) expect(threw).toBe(true);
	});
});

describe("writeLandReceipt → index integration (end to end)", () => {
	test("writing a receipt appends exactly one countable index row reflecting its precision", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "landmetrics-e2e-"));
		await writeLandReceipt(stateDir, receipt({ at: DAY("2026-08-04"), validation: validation(measured) }));
		await writeLandReceipt(stateDir, receipt({ at: DAY("2026-08-04"), branch: "rail/y", commit: "def5678", validation: validation(unmeasured) }));
		await writeLandReceipt(stateDir, receipt({ at: DAY("2026-08-04"), branch: "rail/z", commit: "aaa9999", landed: false, validation: undefined }));

		const read = await readLandReceiptIndex(stateDir);
		expect(read.rows.length).toBe(3);
		const w = landMetricsWindow(read, 7, DAY("2026-08-04"));
		expect(w.lands).toBe(2); // the not-landed row doesn't count
		expect(w.measured).toBe(1); // only the n>0 one is evidence
		expect(w.unmeasured).toBe(1);
	});
});
