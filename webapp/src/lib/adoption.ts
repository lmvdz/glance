/**
 * adoption.ts — client mirror + pure display logic for the dogfood adoption counters
 * (GET /api/adoption → `AdoptionCounters`, src/adoption-counters.ts).
 *
 * The meta-plan (plans/daily-driver/00-meta.md) calls these three per-day counts "the real success
 * metric" of the daily-driver experiment: casual sessions, prompts, and push-taps per UTC day. The
 * daemon writes them sparsely (`{ "YYYY-MM-DD": count }`, days with zero activity absent), so every
 * consumer that wants a trend has to densify a trailing window itself — that's what `metricSummary`
 * does, once, purely, so the panel stays a thin renderer and the math is unit-tested here.
 *
 * Everything is defensive at the trust boundary: `isAdoptionCounters` narrows a payload from a
 * daemon of unknown vintage (mirrors the server's own guard of the same name), and the summaries
 * never divide by zero or NaN-bucket a torn value.
 */

/** `{ "YYYY-MM-DD" (UTC): count }` per metric — the exact GET /api/adoption shape
 *  (src/adoption-counters.ts `AdoptionCounters`). Sparse: zero-activity days are absent. */
export interface AdoptionCounters {
  casualSessionsByDay: Record<string, number>;
  promptsByDay: Record<string, number>;
  pushTapsByDay: Record<string, number>;
}

/** The three metrics, in the order the strip renders them. `key` indexes `AdoptionCounters`. */
export type AdoptionMetricKey = 'casualSessionsByDay' | 'promptsByDay' | 'pushTapsByDay';

export interface AdoptionMetricDef {
  key: AdoptionMetricKey;
  /** Short tile label. */
  label: string;
  /** One-line explanation for a tooltip/aria — what this count actually measures. */
  hint: string;
}

/** Fixed render order: sessions first (the headline adoption signal), then prompts, then taps. */
export const ADOPTION_METRICS: readonly AdoptionMetricDef[] = [
  { key: 'casualSessionsByDay', label: 'Sessions', hint: 'Casual `glance here` / chat sessions started per day' },
  { key: 'promptsByDay', label: 'Prompts', hint: 'Turns you started in a casual session per day' },
  { key: 'pushTapsByDay', label: 'Push taps', hint: 'Push notifications you tapped to open the app per day' },
] as const;

/** Structural narrow for a counters payload that crossed the wire (an old daemon, a proxy error page
 *  that parsed as JSON). Mirrors the server's `isAdoptionCounters`: three record fields, numeric
 *  values only. Anything else is treated as "no data" rather than crashing the strip. */
export function isAdoptionCounters(v: unknown): v is AdoptionCounters {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (['casualSessionsByDay', 'promptsByDay', 'pushTapsByDay'] as const).every((key) => {
    const field = o[key];
    return (
      typeof field === 'object' &&
      field !== null &&
      Object.values(field as Record<string, unknown>).every((n) => typeof n === 'number' && Number.isFinite(n))
    );
  });
}

/** UTC calendar day (`YYYY-MM-DD`) of an epoch-ms timestamp — the exact key the daemon buckets
 *  under (adoption-counters.ts `utcDayOf`), so a trailing-window lookup lines up with the sparse map. */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/** One metric, summarized over a trailing `days`-day UTC window (today inclusive). */
export interface AdoptionMetricSummary {
  /** Oldest→newest per-day counts — the sparkline series (dense, zeros filled). */
  series: number[];
  /** Today's count (UTC). */
  today: number;
  /** Sum across the whole window. */
  total: number;
  /** Highest single-day count in the window (for "peak" context). */
  peak: number;
  /** How many of the `days` had any activity — the "is this being used at all" signal. */
  activeDays: number;
}

/**
 * Densify one sparse `{day: count}` map into a trailing `days`-day window and summarize it. Pure and
 * `now`-injectable so the whole thing is unit-testable without a clock. Oldest day is first in
 * `series` (Sparkline draws left→right = past→present).
 */
export function metricSummary(byDay: Record<string, number> | undefined, days: number, now: number = Date.now()): AdoptionMetricSummary {
  const map = byDay ?? {};
  const series: number[] = [];
  // Walk oldest→newest so the sparkline reads left(past)→right(now).
  for (let i = days - 1; i >= 0; i--) {
    const raw = map[utcDayKey(now - i * DAY_MS)];
    series.push(typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0);
  }
  const total = series.reduce((a, b) => a + b, 0);
  return {
    series,
    today: series[series.length - 1] ?? 0,
    total,
    peak: series.length ? Math.max(...series) : 0,
    activeDays: series.filter((n) => n > 0).length,
  };
}

/** True when every metric is empty across the whole window — the panel's "nothing captured yet"
 *  empty state (distinct from a fetch error). */
export function isAdoptionEmpty(counters: AdoptionCounters | null | undefined, days: number, now: number = Date.now()): boolean {
  if (!counters) return true;
  return ADOPTION_METRICS.every((m) => metricSummary(counters[m.key], days, now).total === 0);
}
