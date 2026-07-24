/**
 * adoption-view.ts — pure transforms behind the Daily driver panel (plans/daily-driver-w15/04).
 *
 * The daemon exposes two invisible signals the meta-plan calls the loop's real success metric:
 *   - GET /api/adoption  -> three sparse `{ "YYYY-MM-DD" (UTC): count }` maps (src/adoption-counters.ts)
 *   - GET /api/friction  -> `{ entries: FrictionEntry[] }`, newest-first (src/friction-log.ts)
 *
 * These helpers turn both wire shapes into render-ready view models WITHOUT any React or fetch, so
 * every decision (the 7-day window, the trailing-week sum, "has anything happened?", the legacy
 * sourceless-row -> "human" default, the auto/human context prettifier) is unit-tested in isolation.
 * They are also the trust boundary: a payload of unknown vintage is coerced to a safe zero/empty
 * shape rather than crashing the panel (mirrors src/adoption-counters.ts's `isAdoptionCounters`).
 */

/** Mirrors src/adoption-counters.ts's `AdoptionCounters` wire shape (sparse per-UTC-day maps). */
export interface AdoptionCountersWire {
  casualSessionsByDay: Record<string, number>;
  promptsByDay: Record<string, number>;
  pushTapsByDay: Record<string, number>;
  roomInteractionsByDay?: Record<string, number>;
}

/** Mirrors src/types.ts's `FrictionEntry`. `source` is absent on any row written before the field
 *  existed AND on every human capture surface today -- readers default a missing value to "human"
 *  (see `frictionSource`), never crash. */
export interface FrictionEntryWire {
  id: string;
  ts: number;
  agentId?: string;
  repo: string;
  context?: string;
  gripe: string;
  source?: 'human' | 'auto';
}

const DAY_MS = 86_400_000;

/** UTC calendar day of an epoch-ms timestamp, `YYYY-MM-DD` -- the same DST-free bucketing the daemon
 *  counts under (src/adoption-counters.ts `utcDayOf`), so the panel's window lines up with the file. */
export function utcDayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** One counter's render model: today's value, the trailing-7-day sum (today inclusive), and the
 *  7-point series oldest->newest (`spark[6]` is today) for the inline sparkline. */
export interface CounterSeries {
  key: 'sessions' | 'prompts' | 'pushTaps' | 'roomInteractions';
  label: string;
  today: number;
  week: number;
  spark: number[];
}

export interface AdoptionView {
  /** Today's UTC day (`YYYY-MM-DD`). */
  day: string;
  series: CounterSeries[];
  /** Anything at all in the trailing-7-day window -- the honest-empty-state gate. Zero activity is
   *  a real, first-class state ("no activity recorded"), never fake zeros dressed up as data. */
  hasActivity: boolean;
}

/** True iff `v` is a structurally-valid counters payload (three legacy record fields plus optional
 *  room interactions, all numeric) -- mirrors src/adoption-counters.ts's `isAdoptionCounters`,
 *  applied at the daemon trust boundary. */
export function isAdoptionCountersWire(v: unknown): v is AdoptionCountersWire {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (['casualSessionsByDay', 'promptsByDay', 'pushTapsByDay'] as const).every((k) => {
    const field = o[k];
    return typeof field === 'object' && field !== null && Object.values(field as Record<string, unknown>).every((n) => typeof n === 'number' && Number.isFinite(n));
  });
}

/** Coerce an untyped `/api/adoption` body to a safe counters shape -- a malformed/old-daemon payload
 *  becomes all-empty (-> honest "no activity") instead of throwing inside the panel. */
export function coerceAdoptionCounters(v: unknown): AdoptionCountersWire {
  if (!isAdoptionCountersWire(v)) return { casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {}, roomInteractionsByDay: {} };
  return { ...v, roomInteractionsByDay: v.roomInteractionsByDay ?? {} };
}

const COUNTER_DEFS: ReadonlyArray<{ key: CounterSeries['key']; label: string; pick: (c: AdoptionCountersWire) => Record<string, number> }> = [
  { key: 'sessions', label: 'Casual sessions', pick: (c) => c.casualSessionsByDay },
  { key: 'prompts', label: 'Prompts', pick: (c) => c.promptsByDay },
  { key: 'pushTaps', label: 'Push taps', pick: (c) => c.pushTapsByDay },
  { key: 'roomInteractions', label: 'Room interactions', pick: (c) => c.roomInteractionsByDay ?? {} },
];

/**
 * Build the four counter series over the trailing 7 UTC days (today inclusive). `now` is injectable
 * so the window is deterministic in tests. Missing days read as 0 (the maps are sparse). Pure.
 */
export function buildAdoptionView(counters: AdoptionCountersWire, now: number = Date.now()): AdoptionView {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(utcDayOf(now - i * DAY_MS)); // oldest -> today
  const series = COUNTER_DEFS.map(({ key, label, pick }) => {
    const rec = pick(counters);
    const spark = days.map((d) => rec[d] ?? 0);
    return { key, label, today: spark[spark.length - 1], week: spark.reduce((a, b) => a + b, 0), spark };
  });
  return { day: days[days.length - 1], series, hasActivity: series.some((s) => s.week > 0) };
}

/** The filer of a row. A missing/legacy/garbage `source` reads as "human" -- the read-side migration
 *  default (src/friction-log.ts's `withSourceDefault`), so an old friction.jsonl row never crashes
 *  and never mis-renders as auto. Only an explicit `"auto"` is auto. */
export function frictionSource(e: Pick<FrictionEntryWire, 'source'>): 'human' | 'auto' {
  return e.source === 'auto' ? 'auto' : 'human';
}

/** The daemon's three fixed auto-capture causes (src/squad-manager.ts `captureAutoFriction`), mapped
 *  to a calm human label. */
const AUTO_CONTEXT_LABELS: Readonly<Record<string, string>> = {
  'auto:boundary-sync-held': 'boundary sync held',
  'auto:acp-timeout': 'ACP timeout',
  'auto:session-loss': 'session lost',
};

/**
 * A short chip label for a row's `context`, or `null` when there's nothing worth a chip. Auto rows
 * carry `auto:<cause>` -- mapped to a friendly phrase (any unknown `auto:*` degrades to the stripped,
 * de-hyphenated tail rather than showing raw). Human rows carry the capture surface ("cli", "tui",
 * "webapp-composer", "here") or free-form situational context, passed through as-is.
 */
export function frictionContextLabel(e: Pick<FrictionEntryWire, 'context'>): string | null {
  const raw = e.context?.trim();
  if (!raw) return null;
  if (raw in AUTO_CONTEXT_LABELS) return AUTO_CONTEXT_LABELS[raw];
  if (raw.startsWith('auto:')) return raw.slice('auto:'.length).replace(/-/g, ' ').trim() || null;
  return raw;
}

/** Coerce an untyped `/api/friction` body (`{ entries: [...] }`) to the rows that are safe to render:
 *  a valid id/ts/gripe/repo. Legacy sourceless rows pass through untouched (they render as human);
 *  torn/foreign lines are dropped, never NaN-bucketed or crash-rendered. Newest-first order (the
 *  server already reverses) is preserved. */
export function coerceFrictionEntries(v: unknown): FrictionEntryWire[] {
  const arr = (v as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(arr)) return [];
  const out: FrictionEntryWire[] = [];
  for (const row of arr) {
    if (typeof row !== 'object' || row === null) continue;
    const o = row as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.ts !== 'number' || !Number.isFinite(o.ts) || typeof o.gripe !== 'string' || !o.gripe.trim()) continue;
    out.push({
      id: o.id,
      ts: o.ts,
      repo: typeof o.repo === 'string' ? o.repo : '',
      gripe: o.gripe,
      ...(typeof o.context === 'string' ? { context: o.context } : {}),
      ...(typeof o.agentId === 'string' ? { agentId: o.agentId } : {}),
      ...(o.source === 'auto' || o.source === 'human' ? { source: o.source } : {}),
    });
  }
  return out;
}

/** Split rows by filer for the ledger's count sub-line ("N auto - M yours"). */
export function frictionCounts(entries: FrictionEntryWire[]): { auto: number; human: number } {
  let auto = 0;
  for (const e of entries) if (frictionSource(e) === 'auto') auto++;
  return { auto, human: entries.length - auto };
}
