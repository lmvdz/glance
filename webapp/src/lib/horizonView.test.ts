import { describe, expect, test } from "bun:test";
import { coerceHorizonCurve, coverageSentence, formatHorizonMs, horizonBandRows, horizonSentence, type HorizonCurveWire } from "./horizonView";

const MIN = 60_000;

function wire(over: Partial<HorizonCurveWire> = {}): HorizonCurveWire {
	return {
		bands: [
			{ ceilingMs: 5 * MIN, attempts: 6, successes: 6, rate: 1 },
			{ ceilingMs: 15 * MIN, attempts: 6, successes: 4, rate: 4 / 6 },
			{ ceilingMs: 30 * MIN, attempts: 0, successes: 0, rate: null },
		],
		points: [
			{ reliability: 0.5, horizonMs: 15 * MIN, attempts: 12 },
			{ reliability: 0.8, horizonMs: 5 * MIN, attempts: 6 },
		],
		coverage: { receipts: 20, noVerdict: 6, abstained: 2, noDuration: 0, sampled: 12 },
		...over,
	};
}

describe("coerceHorizonCurve", () => {
	test("round-trips a well-formed payload and rejects half-shapes", () => {
		expect(coerceHorizonCurve(wire())).toEqual(wire());
		expect(coerceHorizonCurve(undefined)).toBeUndefined();
		expect(coerceHorizonCurve({ bands: "nope" })).toBeUndefined();
		// Malformed band rows are dropped, not guessed at.
		const c = coerceHorizonCurve({ ...wire(), bands: [{ ceilingMs: "x" }, ...wire().bands] })!;
		expect(c.bands.length).toBe(3);
	});

	test("REGRESSION (review finding): a point without numeric attempts is dropped — zero-fill would bypass the evidence floor", () => {
		const c = coerceHorizonCurve({ ...wire(), points: [{ reliability: 0.8, horizonMs: 24 * 60 * MIN }, ...wire().points] })!;
		expect(c.points.length).toBe(2);
		expect(c.points.every((p) => Number.isFinite(p.attempts))).toBeTrue();
	});
});

describe("horizonSentence — the sentence is the reading, and it never overstates", () => {
	test("each claim carries its own cumulative n, never the total", () => {
		expect(horizonSentence(wire())).toBe(
			"validated tasks up to ~5m (n=6) land at 80% reliability; up to ~15m (n=12) at 50%. Above that, expect to re-run or re-scope.",
		);
	});

	test("REGRESSION (review finding): thin validated coverage is said in the headline itself", () => {
		const s = horizonSentence(wire({ coverage: { receipts: 100, noVerdict: 88, abstained: 0, noDuration: 0, sampled: 12 } }));
		expect(s).toContain("Only 12 of 100 runs carried a validator verdict — this describes that slice, not everything the fleet did.");
	});

	test("no validated attempts is stated as absence of evidence", () => {
		const s = horizonSentence(wire({ coverage: { receipts: 9, noVerdict: 9, abstained: 0, noDuration: 0, sampled: 0 }, points: [] }));
		expect(s).toContain("no evidence, not as no ability");
	});

	test("samples without a qualifying ceiling say 'not yet enough', no hollow numbers", () => {
		const s = horizonSentence(
			wire({
				points: [
					{ reliability: 0.5, horizonMs: null, attempts: 0 },
					{ reliability: 0.8, horizonMs: null, attempts: 0 },
				],
				coverage: { receipts: 4, noVerdict: 0, abstained: 0, noDuration: 0, sampled: 4 },
			}),
		);
		expect(s).toContain("not yet enough");
	});

	test("a point with a horizon but zero attempts renders no claim (client-side evidence floor)", () => {
		const s = horizonSentence(
			wire({
				points: [
					{ reliability: 0.5, horizonMs: 15 * MIN, attempts: 0 },
					{ reliability: 0.8, horizonMs: 5 * MIN, attempts: 0 },
				],
			}),
		);
		expect(s).toContain("not yet enough");
	});
});

test("coverageSentence discloses every exclusion class", () => {
	expect(coverageSentence(wire())).toBe("12 of 20 runs carry a validated outcome (excluded: 6 without a validator verdict, 2 abstained/inconclusive).");
});

test("horizonBandRows labels ranges, drops empty bands, and marks the open band as evidence-only range", () => {
	const withOpen = wire({
		bands: [...wire().bands, { ceilingMs: 6000 * MIN, open: true, attempts: 5, successes: 5, rate: 1 }],
	});
	expect(horizonBandRows(withOpen)).toEqual([
		{ label: "≤5m", attempts: 6, rateLabel: "100% of 6" },
		{ label: "5m–15m", attempts: 6, rateLabel: "67% of 6" },
		{ label: ">30m", attempts: 5, rateLabel: "100% of 5" },
	]);
});

test("formatHorizonMs picks the readable unit", () => {
	expect(formatHorizonMs(30_000)).toBe("30s");
	expect(formatHorizonMs(15 * MIN)).toBe("15m");
	expect(formatHorizonMs(90 * MIN)).toBe("1.5h");
	expect(formatHorizonMs(120 * MIN)).toBe("2h");
});
