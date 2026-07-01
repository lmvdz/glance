/**
 * omp-graph schema — the normalized wire format for the living temporal dashboard.
 *
 * The whole extensibility story rests on one claim: every organizational signal
 * reduces to ONE of five track primitives on a shared time axis. Commits, MRR,
 * meetings, CRM deals — all of them are events, series, bars, spans, or bands.
 * Get this schema right and any data source becomes a pluggable adapter
 * (see adapter.ts) that the renderer draws without knowing where it came from.
 *
 * Dependency-free ON PURPOSE: this file is the shared contract between the
 * server-side adapters (src/omp-graph/adapters/*) and the future webapp renderer,
 * and is meant to be extracted verbatim into a standalone `omp-graph` package.
 * No imports from the rest of the codebase belong here.
 */

/** Epoch milliseconds (absolute, UTC). The renderer localizes; adapters emit absolute. */
export type TimeMs = number;

export interface TimeRange {
	start: TimeMs;
	end: TimeMs;
}

/** The five primitives every organizational signal reduces to. */
export type TrackType = "events" | "series" | "bars" | "spans" | "bands";

/** A discrete moment — a commit, a deal closed, a meeting start, a milestone. */
export interface EventMark {
	t: TimeMs;
	label: string;
	/** free categorical tag for color/legend, e.g. "land" | "feat" | "deal-won". */
	kind?: string;
	/** optional magnitude (churn, $ value) for sizing/ranking. */
	value?: number;
	/** structured detail for the hover card. */
	meta?: Record<string, string | number>;
}

/** A sample of a continuous value at a time — MRR, cost/hr, heart rate. */
export interface SeriesPoint {
	t: TimeMs;
	v: number;
}

/** A bucketed count/sum over a fixed window — commits/hr, signups/day. */
export interface Bin {
	t: TimeMs;
	v: number;
}

/** Something with a duration — an agent run, a meeting, a subscription, a deal-in-stage. */
export interface Span {
	t0: TimeMs;
	t1: TimeMs;
	label: string;
	/** color/lane hint, e.g. "working" | "won" | "busy". */
	status?: string;
	value?: number;
	meta?: Record<string, string | number>;
}

/** A stretch of categorical state — fleet state, deal stage, busy/free. */
export interface BandSegment {
	t0: TimeMs;
	t1: TimeMs;
	category: string;
	/** optional explicit color; otherwise the renderer assigns per category. */
	color?: string;
}

/** Non-linear value scaling hint for the renderer (churn/cost spikes crush linear). */
export type Scale = "linear" | "sqrt" | "log";

interface TrackBase {
	/** stable unique id, e.g. "git.commits". */
	id: string;
	/** display label, e.g. "COMMITS". */
	label: string;
	/** group id this track sits under, e.g. "fleet". */
	group: string;
	/** the adapter that produced it (provenance + legend). */
	source: string;
	/** optional unit, e.g. "$" | "commits" | "ms". */
	unit?: string;
}

/** One track: a discriminated union over the five primitives. */
export type GraphTrack =
	| (TrackBase & { type: "events"; marks: EventMark[] })
	| (TrackBase & { type: "series"; points: SeriesPoint[]; scale?: Scale })
	| (TrackBase & { type: "bars"; bins: Bin[]; binMs: number; scale?: Scale })
	| (TrackBase & { type: "spans"; spans: Span[] })
	| (TrackBase & { type: "bands"; segments: BandSegment[] });

/** A named lane group, e.g. "FLEET ACTIVITY" or "REVENUE". */
export interface GraphGroup {
	id: string;
	label: string;
	order?: number;
}

/** The full normalized document a renderer consumes — the omp-graph wire format. */
export interface GraphDoc {
	range: TimeRange;
	groups: GraphGroup[];
	tracks: GraphTrack[];
	/** adapter ids that contributed (legend / debugging). */
	sources: string[];
	generatedAt: TimeMs;
}

// ───────────────────────────── helpers ─────────────────────────────

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** True when t falls within [range.start, range.end). */
export function inRange(t: TimeMs, range: TimeRange): boolean {
	return t >= range.start && t < range.end;
}

/**
 * Bucket timestamped values into fixed-width bins across the range (sum per bin).
 * The workhorse adapters use to turn raw events into a `bars` track. Bin `t` is
 * the bin's start; out-of-range items are dropped.
 */
export function bucketSums(range: TimeRange, binMs: number, items: Iterable<{ t: TimeMs; v: number }>): Bin[] {
	const span = Math.max(0, range.end - range.start);
	const n = Math.max(1, Math.ceil(span / binMs));
	const acc = new Array<number>(n).fill(0);
	for (const { t, v } of items) {
		if (!inRange(t, range)) continue;
		const i = Math.floor((t - range.start) / binMs);
		if (i >= 0 && i < n) acc[i] += v;
	}
	return acc.map((v, i) => ({ t: range.start + i * binMs, v }));
}

/** A default N-days-back-to-now range, aligned to now. */
export function lastDays(days: number, now: TimeMs): TimeRange {
	const end = now;
	return { start: end - days * DAY_MS, end };
}

/**
 * A window spanning `pastDays` before now to `futureDays` after — so adapters
 * with forward-looking data (upcoming meetings, scheduled renewals) have room to
 * render. `futureDays` = 0 collapses to `lastDays`. The renderer marks `now`.
 */
export function windowRange(pastDays: number, futureDays: number, now: TimeMs): TimeRange {
	return { start: now - pastDays * DAY_MS, end: now + Math.max(0, futureDays) * DAY_MS };
}
