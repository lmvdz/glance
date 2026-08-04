import { describe, expect, test } from "bun:test";
import { computeHorizonCurve, DEFAULT_MIN_ATTEMPTS, samplesFromReceipts, type HorizonSample } from "../src/horizon-curve.ts";
import type { RunReceipt } from "../src/types.ts";

/** Minimal receipt: only the fields the curve reads. */
function receipt(over: Partial<RunReceipt>): RunReceipt {
	return { agentId: "a", name: "a", repo: "r", runId: "run", startedAt: 1, status: "stopped", toolCalls: 0, toolTally: {}, filesTouched: [], ...over } as RunReceipt;
}

const v = (verdict: "pass" | "veto" | "abstain" | "skipped" | "inconclusive") =>
	({ verdict, agreement: 1, confidence: 1, perCriterion: [], rationale: "" }) as RunReceipt["validation"];

const MIN = 60_000;

describe("samplesFromReceipts — only validated outcomes count, everything else disclosed", () => {
	test("pass/veto sample; no-verdict, abstains, and no-duration are excluded with counts", () => {
		const { samples, coverage } = samplesFromReceipts([
			receipt({ durationMs: 10 * MIN, validation: v("pass") }),
			receipt({ durationMs: 20 * MIN, validation: v("veto") }),
			receipt({ durationMs: 30 * MIN }), // chat/scout — no verdict
			receipt({ durationMs: 40 * MIN, validation: v("abstain") }),
			receipt({ durationMs: 41 * MIN, validation: v("inconclusive") }),
			receipt({ validation: v("pass") }), // verdict but never finalized a duration
		]);
		expect(samples).toEqual([
			{ durationMs: 10 * MIN, ok: true },
			{ durationMs: 20 * MIN, ok: false },
		]);
		expect(coverage).toEqual({ receipts: 6, noVerdict: 1, abstained: 2, noDuration: 1, sampled: 2 });
	});
});

describe("computeHorizonCurve — the statistical-honesty contract", () => {
	const curve = (samples: HorizonSample[], opts = {}) =>
		computeHorizonCurve(samples, { receipts: samples.length, noVerdict: 0, abstained: 0, noDuration: 0, sampled: samples.length }, opts);

	test("monotone band-wise horizons: each size class must demonstrate the reliability itself", () => {
		const samples: HorizonSample[] = [
			// ≤5m: 6/6 (100%) — anchors both reliabilities.
			...Array.from({ length: 6 }, (_, i) => ({ durationMs: (i + 1) * 30_000, ok: true })),
			// 5–15m: 4/6 (67%) — clears 50%, fails 80%.
			...Array.from({ length: 6 }, (_, i) => ({ durationMs: 6 * MIN + i * MIN, ok: i < 4 })),
			// 15–30m: 0/6 — blocks everything beyond 15m.
			...Array.from({ length: 6 }, (_, i) => ({ durationMs: 16 * MIN + i * MIN, ok: false })),
		];
		const c = curve(samples);
		expect(c.points.find((p) => p.reliability === 0.8)).toEqual({ reliability: 0.8, horizonMs: 5 * MIN, attempts: 6 });
		expect(c.points.find((p) => p.reliability === 0.5)).toEqual({ reliability: 0.5, horizonMs: 15 * MIN, attempts: 12 });
	});

	test("REGRESSION (codex finding): failing small tasks block a lucky big band from claiming 'up to'", () => {
		const samples: HorizonSample[] = [
			...Array.from({ length: 5 }, () => ({ durationMs: 1 * MIN, ok: false })),
			...Array.from({ length: 5 }, () => ({ durationMs: 90 * MIN, ok: true })),
		];
		const c = curve(samples);
		// The ≤5m class failed on its own evidence: no larger ceiling may claim "up to" past it,
		// at ANY reliability — a pooled 5/10 would technically clear 50% but describes no size
		// class an operator can actually hand work in.
		expect(c.points.every((p) => p.horizonMs === null)).toBeTrue();
	});

	test("REGRESSION (grok finding): short-task mass cannot launder a long ceiling", () => {
		const samples: HorizonSample[] = [
			...Array.from({ length: 99 }, () => ({ durationMs: 3 * MIN, ok: true })),
			{ durationMs: 200 * MIN, ok: false }, // the one long attempt, vetoed
		];
		const c = curve(samples);
		// 99 pooled passes must not carry the 4h ceiling: the horizon stays at the class that
		// demonstrated itself.
		expect(c.points.find((p) => p.reliability === 0.8)).toEqual({ reliability: 0.8, horizonMs: 5 * MIN, attempts: 99 });
	});

	test("an empty middle band neither blocks nor anchors: flanking demonstrated classes extend", () => {
		const samples: HorizonSample[] = [
			...Array.from({ length: 6 }, () => ({ durationMs: 3 * MIN, ok: true })),
			...Array.from({ length: 6 }, () => ({ durationMs: 25 * MIN, ok: true })),
		];
		const c = curve(samples);
		expect(c.points.find((p) => p.reliability === 0.8)).toEqual({ reliability: 0.8, horizonMs: 30 * MIN, attempts: 12 });
	});

	test("REGRESSION (review finding): the open band shows evidence but never anchors a horizon", () => {
		const samples: HorizonSample[] = [
			...Array.from({ length: 4 }, (_, i) => ({ durationMs: 241 * MIN + i * MIN, ok: true })),
			{ durationMs: 6000 * MIN, ok: true }, // the 100-hour outlier
		];
		const c = curve(samples);
		const open = c.bands[c.bands.length - 1]!;
		expect(open.open).toBeTrue();
		expect(open.attempts).toBe(5); // evidence is visible…
		expect(c.points.every((p) => p.horizonMs === null)).toBeTrue(); // …but no claim is minted from it
	});

	test("a lucky pair never qualifies below minAttempts", () => {
		const samples: HorizonSample[] = [
			{ durationMs: 100 * MIN, ok: true },
			{ durationMs: 110 * MIN, ok: true },
		];
		const c = curve(samples);
		expect(c.points.every((p) => p.horizonMs === null)).toBeTrue();
		expect(DEFAULT_MIN_ATTEMPTS).toBeGreaterThan(2);
	});

	test("empty input: bands exist, every point null, coverage passthrough", () => {
		const c = curve([]);
		expect(c.points.every((p) => p.horizonMs === null && p.attempts === 0)).toBeTrue();
		expect(c.bands.every((b) => b.rate === null)).toBeTrue();
		expect(c.bands.every((b) => !b.open)).toBeTrue(); // no samples above the last declared ceiling
	});
});
