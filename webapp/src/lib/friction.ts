/**
 * friction.ts — client mirror + pure display logic for the dogfood friction ledger
 * (GET /api/friction → `{ entries: FrictionEntry[] }`, src/friction-log.ts + src/server.ts).
 *
 * The ledger is the daily-driver loop's captured-gripe substrate: annoyances typed via `glance grr`
 * and (once daily-driver-w15 concern 02 lands) friction the daemon auto-captures from real incidents
 * (held syncs, ACP timeouts, session-loss). The weekly drain buckets human gripes vs auto-captured
 * ones; this view lets a human browse and triage the same ledger in-UI instead of only on the CLI.
 *
 * DEFENSIVE BY DESIGN — this worktree is stacked BELOW concern 02, so the daemon here may not yet
 * write a `source` discriminator at all:
 *   - `normalizeFrictionResponse` accepts the real `{entries:[...]}` envelope, a bare array (a
 *     future/older shape), or garbage → always a clean `FrictionEntry[]`.
 *   - `frictionSource` treats an ABSENT discriminator as "human" (the pre-02 default), and reads
 *     EITHER convention concern 02 might ship — an explicit `source: "auto"` field OR an `auto:*`
 *     `context` prefix — so this view is correct whichever the implementer picks.
 */

/** One captured gripe — the persisted `FrictionEntry` shape (src/types.ts). `source` is optional
 *  because it doesn't exist on this branch's daemon yet (concern 02 adds it); absent ⇒ human. */
export interface FrictionEntry {
  id: string;
  ts: number;
  agentId?: string;
  /** Repo the operator was in when annoyance struck ("" when genuinely unknown). */
  repo: string;
  /** Capture surface ("cli" / "tui" / "webapp-composer" / "here") or, for auto-capture, an
   *  `auto:<subtype>` situational tag. */
  context?: string;
  gripe: string;
  /** Concern-02 discriminator (may be absent on an older daemon — absent ⇒ human). */
  source?: FrictionSource;
}

export type FrictionSource = 'human' | 'auto';

/** The `auto:*` context convention concern 02 may use instead of a `source` field. */
const AUTO_CONTEXT_PREFIX = 'auto:';

/** Narrow one wire value to a `FrictionEntry` — the fields this view actually reads. A torn/foreign
 *  line (missing id, non-string gripe, non-numeric ts) is dropped, never half-rendered. */
export function isFrictionEntry(v: unknown): v is FrictionEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.gripe === 'string' &&
    typeof o.ts === 'number' &&
    Number.isFinite(o.ts) &&
    typeof o.repo === 'string'
  );
}

/**
 * Coerce ANY GET /api/friction body into a clean, newest-first `FrictionEntry[]`.
 * Accepts the real `{ entries: [...] }` envelope, a bare array, or neither (→ []). The server
 * already returns newest-first, but a bare-array or older source might not, so we sort defensively.
 */
export function normalizeFrictionResponse(raw: unknown): FrictionEntry[] {
  let list: unknown[];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown[] }).entries)) {
    list = (raw as { entries: unknown[] }).entries;
  } else list = [];
  return list.filter(isFrictionEntry).sort((a, b) => b.ts - a.ts);
}

/**
 * Classify a gripe as human-typed or daemon-auto-captured. Absent discriminator ⇒ "human" (the
 * pre-concern-02 default). Reads whichever convention concern 02 ships: an explicit `source` field
 * wins; otherwise an `auto:` context prefix marks it auto.
 */
export function frictionSource(e: Pick<FrictionEntry, 'source' | 'context'>): FrictionSource {
  if (e.source === 'auto' || e.source === 'human') return e.source;
  if (typeof e.context === 'string' && e.context.toLowerCase().startsWith(AUTO_CONTEXT_PREFIX)) return 'auto';
  return 'human';
}

/** The subtype an auto-captured gripe carries after its `auto:` prefix (e.g. `auto:acp-timeout` →
 *  `acp-timeout`); '' for a human gripe or a bare `auto:`. */
export function autoSubtype(e: Pick<FrictionEntry, 'source' | 'context'>): string {
  if (frictionSource(e) !== 'auto') return '';
  const ctx = e.context ?? '';
  const i = ctx.toLowerCase().startsWith(AUTO_CONTEXT_PREFIX) ? AUTO_CONTEXT_PREFIX.length : 0;
  return ctx.slice(i).trim();
}

/** The short context chip label: the auto subtype for auto rows, the raw context for human rows,
 *  '' when there's nothing worth showing. */
export function contextLabel(e: Pick<FrictionEntry, 'source' | 'context'>): string {
  const sub = autoSubtype(e);
  if (sub) return sub;
  const ctx = (e.context ?? '').trim();
  return ctx.toLowerCase() === AUTO_CONTEXT_PREFIX ? '' : ctx;
}

/** Basename of a repo path for a compact chip; '' → 'unknown repo'. */
export function repoLabel(repo: string): string {
  const trimmed = (repo ?? '').replace(/\/+$/, '');
  if (!trimmed) return 'unknown repo';
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return base || trimmed;
}

export type FrictionFilter = 'all' | 'human' | 'auto';

/** Apply the source filter. 'all' passes everything; otherwise keep rows whose classified source
 *  matches. Order is preserved (caller hands us newest-first). */
export function filterFriction(entries: FrictionEntry[], filter: FrictionFilter): FrictionEntry[] {
  if (filter === 'all') return entries;
  return entries.filter((e) => frictionSource(e) === filter);
}

/** Count by source, for the filter tab badges. */
export function sourceCounts(entries: FrictionEntry[]): { all: number; human: number; auto: number } {
  let human = 0;
  let auto = 0;
  for (const e of entries) (frictionSource(e) === 'auto' ? (auto += 1) : (human += 1));
  return { all: entries.length, human, auto };
}
