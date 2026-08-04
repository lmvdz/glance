/**
 * Horizon × reliability curve (CS329A borrow #2, plans/deepen-modules/15 — METR's result):
 * a single unconditioned success rate hides the axis operators plan around. A fleet that lands
 * 59-minute-class work at 50% reliability may only land ~15-minute-class work at 80% — "how big
 * a task can I hand the fleet AND trust the result" depends on which reliability you need.
 *
 * Computed over persisted RunReceipts. The success signal is deliberately narrow and honest:
 * ONLY receipts carrying an independent-validator verdict participate (`validation.verdict`,
 * Epic 3) — `pass` succeeds, `veto` fails, and abstain/skipped/inconclusive are EXCLUDED (an
 * abstention is not evidence either way). Receipts with no verdict at all (chat sessions,
 * scouts, never-landed runs) are likewise excluded rather than guessed at. The payload
 * discloses every exclusion count so sparse coverage reads as sparse coverage, never as a
 * confident curve (house rule: no silent caps — a metric that quietly guesses is a metric
 * that lies).
 *
 * Statistical-honesty contract (every clause bought by an adversarial-review finding,
 * 2026-08-03 — two rounds; the first fix over-corrected and the second round caught THAT):
 *  - A horizon claim is MONOTONE and BAND-WISE: ceiling C qualifies at reliability r only if
 *    every populated band at or below C clears r on its OWN samples, and the band anchoring C
 *    carries at least `minAttempts` of them. Per-band-only lets a lucky big band claim "up to"
 *    while small tasks fail (round 1); cumulative pooling lets 99 short passes launder one
 *    vetoed 4-hour run into a 4-hour horizon (round 2). Band-wise-with-monotonicity is the
 *    claim an operator actually needs: every size class up to X has demonstrated r itself.
 *  - Horizon points qualify only at DECLARED band ceilings. The implicit top band (everything
 *    longer than the last declared ceiling) appears in the evidence table but can never anchor
 *    a horizon claim — one 100-hour outlier must not mint a 100-hour horizon.
 *  - A point's `attempts` is the populated evidence at or below its ceiling — what the claim
 *    actually inspected — never the total sample count.
 *
 * Pure — receipts in, curve out; the HTTP route feeds it `manager.allReceipts()`.
 */
import type { RunReceipt } from "./types.ts";

export interface HorizonSample {
	durationMs: number;
	ok: boolean;
}

export interface HorizonBand {
	/** Upper edge of the band (ms); tasks with durationMs ≤ ceiling and > the previous ceiling. */
	ceilingMs: number;
	/** True for the implicit catch-all above the last declared ceiling — shown as evidence,
	 *  never eligible as a horizon point. */
	open?: boolean;
	attempts: number;
	successes: number;
	/** successes/attempts within this band; null when the band is empty. */
	rate: number | null;
}

export interface HorizonPoint {
	reliability: number;
	/** Largest DECLARED ceiling where every populated band at or below it clears `reliability`
	 *  on its own samples and the anchoring band has ≥ `minAttempts`; null when none qualifies. */
	horizonMs: number | null;
	/** Populated attempts at or below the qualifying ceiling — the evidence the claim inspected. */
	attempts: number;
}

export interface HorizonCurve {
	bands: HorizonBand[];
	points: HorizonPoint[];
	/** Coverage disclosure: how the receipt population shrank to the sample set. */
	coverage: {
		receipts: number;
		noVerdict: number;
		abstained: number;
		noDuration: number;
		sampled: number;
	};
}

/** Default duration bands: 5m / 15m / 30m / 1h / 2h / 4h ceilings. */
export const DEFAULT_BAND_CEILINGS_MS: readonly number[] = [
	5 * 60_000,
	15 * 60_000,
	30 * 60_000,
	60 * 60_000,
	120 * 60_000,
	240 * 60_000,
];

/** The band that ANCHORS a horizon claim needs at least this many of its own attempts —
 *  two lucky lands do not make a 2-hour horizon. */
export const DEFAULT_MIN_ATTEMPTS = 5;

/** Narrow a receipt population to (duration, validated-outcome) samples, with disclosure. */
export function samplesFromReceipts(receipts: RunReceipt[]): { samples: HorizonSample[]; coverage: HorizonCurve["coverage"] } {
	let noVerdict = 0;
	let abstained = 0;
	let noDuration = 0;
	const samples: HorizonSample[] = [];
	for (const r of receipts) {
		const verdict = r.validation?.verdict;
		if (verdict === undefined) {
			noVerdict++;
			continue;
		}
		if (verdict !== "pass" && verdict !== "veto") {
			abstained++;
			continue;
		}
		if (typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs <= 0) {
			noDuration++;
			continue;
		}
		samples.push({ durationMs: r.durationMs, ok: verdict === "pass" });
	}
	return { samples, coverage: { receipts: receipts.length, noVerdict, abstained, noDuration, sampled: samples.length } };
}

export interface HorizonCurveOptions {
	/** Declared band ceilings, ascending. Samples above the last ceiling land in the open band. */
	bandCeilingsMs?: readonly number[];
	/** Reliability levels to report points for. */
	reliabilities?: readonly number[];
	/** Minimum attempts in the anchoring band for a ceiling to qualify as a horizon point. */
	minAttempts?: number;
}

export function computeHorizonCurve(
	samples: HorizonSample[],
	coverage: HorizonCurve["coverage"],
	opts: HorizonCurveOptions = {},
): HorizonCurve {
	const ceilings = [...(opts.bandCeilingsMs ?? DEFAULT_BAND_CEILINGS_MS)].sort((a, b) => a - b);
	const reliabilities = opts.reliabilities ?? [0.5, 0.8];
	const minAttempts = opts.minAttempts ?? DEFAULT_MIN_ATTEMPTS;

	// The open band catches everything longer than the last declared ceiling, so no sample is
	// silently dropped for being big — but it is evidence-display only (see the honesty contract).
	const maxDuration = samples.reduce((m, s) => Math.max(m, s.durationMs), 0);
	const lastDeclared = ceilings[ceilings.length - 1] ?? 0;
	const bands: HorizonBand[] = ceilings.map((ceilingMs) => ({ ceilingMs, attempts: 0, successes: 0, rate: null }));
	if (maxDuration > lastDeclared) {
		bands.push({ ceilingMs: maxDuration, open: true, attempts: 0, successes: 0, rate: null });
	}

	for (const s of samples) {
		const band = bands.find((b) => s.durationMs <= b.ceilingMs) ?? bands[bands.length - 1]!;
		band.attempts++;
		if (s.ok) band.successes++;
	}
	for (const b of bands) b.rate = b.attempts > 0 ? b.successes / b.attempts : null;

	const points: HorizonPoint[] = reliabilities.map((reliability) => {
		let best: { ceilingMs: number; attempts: number } | undefined;
		let inspected = 0;
		for (const b of bands) {
			if (b.open) break; // declared ceilings only — an outlier never anchors a claim
			if (b.attempts === 0) continue; // an empty band neither blocks nor anchors
			// Monotone gate: the first populated band that fails r ends eligibility — a larger
			// ceiling must never claim a size class that failed on its own evidence.
			if (b.rate === null || b.rate < reliability) break;
			inspected += b.attempts;
			// Anchor rule: the claimed size class itself needs real evidence.
			if (b.attempts >= minAttempts) best = { ceilingMs: b.ceilingMs, attempts: inspected };
		}
		return { reliability, horizonMs: best?.ceilingMs ?? null, attempts: best?.attempts ?? 0 };
	});

	return { bands, points, coverage };
}
