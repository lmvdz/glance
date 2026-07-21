/**
 * loop-meters.ts — pure transforms behind the Daily panel's "is the learning tech actually on and
 * being used" meters and the narrative surfaces this pass un-buries.
 *
 * Three daemon signals existed with ZERO webapp readers (the exact "we have all this tech but it's
 * not being used" gap):
 *   - GET /api/metrics/learning-loop -> `{ flags, rollup }` (src/metrics.ts) — which learning flags
 *     resolve on/off right now, plus per-metric rollups over the recent window.
 *   - GET /api/after-action[/:id]    -> durable post-mortems every terminal unit writes
 *     (src/after-action.ts) — previously reachable only through the `glance aar` CLI.
 *   - GET /api/symptoms?browse=1     -> newest recurring failure modes (src/symptoms.ts) —
 *     previously rank-only (⌘K search), invisible unless you already knew what to search for.
 *
 * Same discipline as adoption-view.ts: render-ready view models with no React and no fetch, and a
 * trust boundary — a payload of unknown vintage coerces to a safe empty shape, never a crash.
 */

/** Mirrors src/metrics.ts `LearningFlags` — but as an open record: a NEW flag added server-side must
 *  show up in the panel without a webapp release, and an unknown value renders as "off". */
export type LearningFlagsWire = Record<string, string>;

/** Mirrors src/metrics.ts `MetricRollupRow` (byTag dropped — the panel renders totals only). */
export interface MetricRollupRowWire {
  name: string;
  count: number;
  sum: number;
  avg: number;
}

export interface LearningLoopWire {
  flags: LearningFlagsWire;
  rollup: MetricRollupRowWire[];
}

/** Mirrors src/after-action.ts `AfterActionReport` (markdown carried whole; render, never execute —
 *  it contains redacted agent/gate output). */
export interface AfterActionWire {
  id: string;
  name: string;
  repo: string;
  branch?: string;
  issueIdentifier?: string;
  issueUrl?: string;
  goal?: string;
  terminalReason: string;
  terminalAt: number;
  classification: 'environment' | 'implementation' | 'unknown';
  commitsAhead: number;
  dirtyFiles: number;
  markdown: string;
  createdAt: number;
}

/** Mirrors src/symptoms.ts `SymptomEntry` minus `fixedBy` internals the list view doesn't render. */
export interface SymptomWire {
  id: string;
  symptom: string;
  whereToLook: string[];
  repo: string;
  landedAt: number;
  fixedBy?: { agentId?: string; runId?: string; prNumber?: number };
}

// ── coercers (trust boundary) ────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function coerceLearningLoop(v: unknown): LearningLoopWire {
  if (!isRecord(v)) return { flags: {}, rollup: [] };
  const flags: LearningFlagsWire = {};
  if (isRecord(v.flags)) {
    for (const [k, val] of Object.entries(v.flags)) if (typeof val === 'string') flags[k] = val;
  }
  const rollup: MetricRollupRowWire[] = Array.isArray(v.rollup)
    ? v.rollup.flatMap((r) =>
        isRecord(r) && typeof r.name === 'string' && typeof r.count === 'number'
          ? [{ name: r.name, count: r.count, sum: typeof r.sum === 'number' ? r.sum : 0, avg: typeof r.avg === 'number' ? r.avg : 0 }]
          : [],
      )
    : [];
  return { flags, rollup };
}

export function coerceAfterActions(v: unknown): AfterActionWire[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) =>
    isRecord(r) && typeof r.id === 'string' && typeof r.terminalReason === 'string' && typeof r.markdown === 'string'
      ? [
          {
            id: r.id,
            name: typeof r.name === 'string' ? r.name : r.id,
            repo: typeof r.repo === 'string' ? r.repo : '',
            branch: typeof r.branch === 'string' ? r.branch : undefined,
            issueIdentifier: typeof r.issueIdentifier === 'string' ? r.issueIdentifier : undefined,
            issueUrl: typeof r.issueUrl === 'string' ? r.issueUrl : undefined,
            goal: typeof r.goal === 'string' ? r.goal : undefined,
            terminalReason: r.terminalReason,
            terminalAt: typeof r.terminalAt === 'number' ? r.terminalAt : 0,
            classification: r.classification === 'environment' || r.classification === 'implementation' ? r.classification : 'unknown',
            commitsAhead: typeof r.commitsAhead === 'number' ? r.commitsAhead : -1,
            dirtyFiles: typeof r.dirtyFiles === 'number' ? r.dirtyFiles : -1,
            markdown: r.markdown,
            createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
          } satisfies AfterActionWire,
        ]
      : [],
  );
}

export function coerceSymptoms(v: unknown): SymptomWire[] {
  const list = isRecord(v) && Array.isArray(v.symptoms) ? v.symptoms : [];
  return list.flatMap((s) =>
    isRecord(s) && typeof s.id === 'string' && typeof s.symptom === 'string'
      ? [
          {
            id: s.id,
            symptom: s.symptom,
            whereToLook: Array.isArray(s.whereToLook) ? s.whereToLook.filter((w): w is string => typeof w === 'string') : [],
            repo: typeof s.repo === 'string' ? s.repo : '',
            landedAt: typeof s.landedAt === 'number' ? s.landedAt : 0,
            fixedBy: isRecord(s.fixedBy)
              ? {
                  agentId: typeof s.fixedBy.agentId === 'string' ? s.fixedBy.agentId : undefined,
                  runId: typeof s.fixedBy.runId === 'string' ? s.fixedBy.runId : undefined,
                  prNumber: typeof s.fixedBy.prNumber === 'number' ? s.fixedBy.prNumber : undefined,
                }
              : undefined,
          } satisfies SymptomWire,
        ]
      : [],
  );
}

// ── view builders ────────────────────────────────────────────────────────────────────────────────

/** Display order + labels for the flags the daemon is known to resolve today. Unknown extra flags
 *  render after these, prettified from their camelCase key — never dropped. */
const FLAG_LABELS: [string, string][] = [
  ['failureMemory', 'Failure memory'],
  ['reflexion', 'Reflexion'],
  ['rewardBoost', 'Reward boost'],
  ['modelOutcomes', 'Model outcomes'],
  ['thresholdTuner', 'Threshold tuner'],
  ['decisionCapture', 'Decision capture'],
];

export interface FlagChip {
  key: string;
  label: string;
  on: boolean;
}

function prettifyKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function flagChips(flags: LearningFlagsWire): FlagChip[] {
  const known = FLAG_LABELS.filter(([k]) => k in flags).map(([k, label]) => ({ key: k, label, on: flags[k] === 'on' }));
  const extra = Object.keys(flags)
    .filter((k) => !FLAG_LABELS.some(([known2]) => known2 === k))
    .sort()
    .map((k) => ({ key: k, label: prettifyKey(k), on: flags[k] === 'on' }));
  return [...known, ...extra];
}

/** Labels + formatting per metric. Rate metrics record 0/1 samples, so `avg` IS the rate; count
 *  metrics (fixups-to-green) read best as their average. Unknown metric names still render. */
const METRIC_META: Record<string, { label: string; kind: 'rate' | 'avg' }> = {
  'first-try-green': { label: 'First-try green', kind: 'rate' },
  'fixups-to-green': { label: 'Fixups to green', kind: 'avg' },
  escalation: { label: 'Escalation rate', kind: 'rate' },
  'land-failure-streak': { label: 'Land-failure streaks', kind: 'rate' },
  'primer-empty': { label: 'Primer came up empty', kind: 'rate' },
  'primer-undelivered': { label: 'Primer undeliverable', kind: 'rate' },
};

export interface MeterRow {
  name: string;
  label: string;
  /** Rendered headline, e.g. `72%` for a rate or `1.4` for an average. */
  value: string;
  /** Sample count backing the headline — rendered so a 100% over n=1 can't masquerade as truth. */
  n: number;
}

export function meterRows(rollup: MetricRollupRowWire[]): MeterRow[] {
  return rollup
    .filter((r) => r.count > 0)
    .map((r) => {
      const meta = METRIC_META[r.name] ?? { label: prettifyKey(r.name.replace(/-/g, ' ')), kind: 'avg' as const };
      return {
        name: r.name,
        label: meta.label,
        value: meta.kind === 'rate' ? `${Math.round(r.avg * 100)}%` : r.avg.toFixed(1),
        n: r.count,
      };
    });
}

/** After-action reports relevant to one task: the union of the ids the pipeline/roster still knows.
 *  Sorted newest-terminal-first. Pure so TaskDetail's section is testable without a fetch. */
export function reportsForAgents(all: AfterActionWire[], agentIds: Iterable<string>): AfterActionWire[] {
  const ids = new Set(agentIds);
  return all.filter((r) => ids.has(r.id)).sort((a, b) => b.terminalAt - a.terminalAt);
}
