/**
 * View-model for GET /api/horizon (src/horizon-curve.ts — CS329A borrow #2, METR's
 * horizon×reliability result): the largest task size the fleet lands at 50%/80% reliability,
 * from validated-land receipts only.
 *
 * House rule (MondaySurface's charter): the SENTENCE is the reading. This module turns the
 * payload into one honest sentence plus the band rows behind it, and it never lets sparse
 * coverage read as a confident curve — below the evidence floor the sentence says so instead
 * of showing numbers.
 */

export interface HorizonBandWire {
	ceilingMs: number;
	open?: boolean;
	attempts: number;
	successes: number;
	rate: number | null;
}

export interface HorizonPointWire {
	reliability: number;
	horizonMs: number | null;
	attempts: number;
}

export interface HorizonCurveWire {
	bands: HorizonBandWire[];
	points: HorizonPointWire[];
	coverage: { receipts: number; noVerdict: number; abstained: number; noDuration: number; sampled: number };
}

/** Malformed / old-daemon payload → undefined, never a half-shape (adoption-view's coerce idiom). */
export function coerceHorizonCurve(raw: unknown): HorizonCurveWire | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.bands) || !Array.isArray(r.points) || !r.coverage || typeof r.coverage !== "object") return undefined;
	const cov = r.coverage as Record<string, unknown>;
	const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
	return {
		bands: (r.bands as unknown[]).flatMap((b): HorizonBandWire[] => {
			if (!b || typeof b !== "object") return [];
			const band = b as Record<string, unknown>;
			if (typeof band.ceilingMs !== "number") return [];
			return [{ ceilingMs: band.ceilingMs, ...(band.open === true ? { open: true } : {}), attempts: num(band.attempts), successes: num(band.successes), rate: typeof band.rate === "number" ? band.rate : null }];
		}),
		points: (r.points as unknown[]).flatMap((p): HorizonPointWire[] => {
			if (!p || typeof p !== "object") return [];
			const pt = p as Record<string, unknown>;
			// attempts must be a real number: a point without evidence behind it is dropped, not
			// zero-filled — zero-fill would let a malformed payload bypass the evidence floor and
			// render a confident horizon (adversarial-review finding).
			if (typeof pt.reliability !== "number" || typeof pt.attempts !== "number" || !Number.isFinite(pt.attempts)) return [];
			return [{ reliability: pt.reliability, horizonMs: typeof pt.horizonMs === "number" ? pt.horizonMs : null, attempts: pt.attempts }];
		}),
		coverage: { receipts: num(cov.receipts), noVerdict: num(cov.noVerdict), abstained: num(cov.abstained), noDuration: num(cov.noDuration), sampled: num(cov.sampled) },
	};
}

export function formatHorizonMs(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const min = Math.round(ms / 60_000);
	if (min < 60) return `${min}m`;
	const h = min / 60;
	return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

/** The headline sentence. Sparse evidence gets an honest sentence, not a hollow number; every
 *  claim carries the cumulative sample size it actually rests on (adversarial-review finding:
 *  never cite the total where the point's own n is smaller). */
export function horizonSentence(view: HorizonCurveWire): string {
	if (view.coverage.sampled === 0) {
		return "No validated land attempts on record yet — this reads as no evidence, not as no ability.";
	}
	const claim = (p?: HorizonPointWire): string | undefined =>
		p && p.horizonMs !== null && p.attempts > 0 ? `~${formatHorizonMs(p.horizonMs)} (n=${p.attempts})` : undefined;
	const s80 = claim(view.points.find((p) => p.reliability === 0.8));
	const s50 = claim(view.points.find((p) => p.reliability === 0.5));
	if (!s80 && !s50) {
		return `${view.coverage.sampled} validated attempt${view.coverage.sampled === 1 ? "" : "s"} on record — not yet enough in any size band to state a horizon at 50% or 80% reliability.`;
	}
	const parts: string[] = [];
	if (s80) parts.push(`validated tasks up to ${s80} land at 80% reliability`);
	if (s50) parts.push(`up to ${s50} at 50%`);
	let sentence = `${parts.join("; ")}. Above that, expect to re-run or re-scope.`;
	// Low coverage is said in the headline, not buried in the footer: a horizon over a thin
	// validated slice of a busy fleet is a statement about that slice only.
	if (view.coverage.receipts >= 10 && view.coverage.sampled / view.coverage.receipts < 0.2) {
		sentence += ` Only ${view.coverage.sampled} of ${view.coverage.receipts} runs carried a validator verdict — this describes that slice, not everything the fleet did.`;
	}
	return sentence;
}

/** The disclosure line — why the sample is smaller than the receipt count. */
export function coverageSentence(view: HorizonCurveWire): string {
	const c = view.coverage;
	const excluded: string[] = [];
	if (c.noVerdict > 0) excluded.push(`${c.noVerdict} without a validator verdict`);
	if (c.abstained > 0) excluded.push(`${c.abstained} abstained/inconclusive`);
	if (c.noDuration > 0) excluded.push(`${c.noDuration} without a duration`);
	return excluded.length
		? `${c.sampled} of ${c.receipts} runs carry a validated outcome (excluded: ${excluded.join(", ")}).`
		: `All ${c.receipts} recorded runs carry a validated outcome.`;
}

export interface HorizonBandRow {
	label: string;
	attempts: number;
	rateLabel: string;
}

/** Band rows for display; empty bands are dropped (an empty band is no evidence, not 0%). */
export function horizonBandRows(view: HorizonCurveWire): HorizonBandRow[] {
	let prev = 0;
	const rows: HorizonBandRow[] = [];
	for (const b of view.bands) {
		const label = b.open ? `>${formatHorizonMs(prev)}` : `${prev === 0 ? "≤" : `${formatHorizonMs(prev)}–`}${formatHorizonMs(b.ceilingMs)}`;
		if (b.attempts > 0 && b.rate !== null) {
			rows.push({ label, attempts: b.attempts, rateLabel: `${Math.round(b.rate * 100)}% of ${b.attempts}` });
		}
		if (!b.open) prev = b.ceilingMs;
	}
	return rows;
}
