/**
 * FactoryStatusStrip — the always-visible "is the fleet actually alive?" banner.
 *
 * The trust problem: every autonomous loop defaults ON, but the backlog loops only ARM when a Plane
 * backlog is configured. With none wired they read "on" yet never start and emit no activity — so an
 * idle-but-alive fleet, an armed-but-unfueled fleet, and a dead daemon all looked identical, and the
 * user stopped trusting the factory ("I don't see anything moving automatically").
 *
 * This strip makes the four states unmistakable at first glance, on every view:
 *   moving    (green, breathing + ping) — loops producing and/or agents in flight
 *   idle      (amber, breathing)        — armed & ticking, nothing to do (+ the WHY)
 *   not-armed (amber, solid)            — flag ON but never started (+ the concrete fix)
 *   off       (gray, static)            — flag disabled
 *
 * A live heartbeat dot BREATHES for every alive loop, so the user can SEE the factory is awake even
 * when it has nothing to do. Polls GET /api/factory/status every 7s (independent of the WS roster).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Bell, ChevronDown, RefreshCw, Gauge } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import {
  STATUS_META,
  overallHeadline,
  landBlockedLine,
  loopReasonLine,
  fmtSince,
  ratioLabel,
  type FactoryStatus,
  type FactoryLoopReport,
  type ShadowExitScoreboard,
} from '../lib/factoryStatus';
import { computeCapacity, capacityFractionLabel, detectCollisions, attentionItems, type CapacitySummary, type GovernancePayload, type UsagePayload } from '../lib/insights';
import { toneClasses } from './ui';

// ─── heartbeat dot ───────────────────────────────────────────────────────────

const HeartbeatDot: React.FC<{ report: FactoryLoopReport }> = ({ report }) => {
  const meta = STATUS_META[report.status];
  return (
    <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
      {meta.ping && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${meta.dot}`} />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${meta.dot} ${meta.breathe ? 'animate-pulse' : ''}`} />
    </span>
  );
};

// ─── one loop chip ───────────────────────────────────────────────────────────

const LoopChip: React.FC<{ report: FactoryLoopReport }> = ({ report }) => {
  const meta = STATUS_META[report.status];
  const reason = loopReasonLine(report);
  const heartbeat = report.status === 'idle' || report.status === 'moving';
  const title = [
    report.blurb,
    reason ? `\n${reason}` : '',
    report.fix ? `\nFix: ${report.fix}` : '',
    heartbeat ? `\nLast tick: ${fmtSince(report.secondsSinceLastTick)}` : '',
  ]
    .join('')
    .trim();

  return (
    <div
      className={`flex min-w-0 flex-shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 ${meta.border} ${meta.bg}`}
      title={title}
    >
      <HeartbeatDot report={report} />
      <div className="flex min-w-0 flex-col leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">{report.label}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${meta.text}`}>{meta.label}</span>
          {heartbeat && report.secondsSinceLastTick !== undefined && (
            <span className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500">{fmtSince(report.secondsSinceLastTick)}</span>
          )}
        </div>
        {reason && (
          <span className="max-w-[15rem] truncate text-[10px] text-gray-500 dark:text-gray-400" title={reason}>
            {reason}
          </span>
        )}
      </div>
    </div>
  );
};

// ─── shadow-exit scoreboard (adw-factory-borrows concern 09) ────────────────────────────────────
//
// "This concern's definition of done includes the surface existing, not the flips being made" (the
// concern doc) — lane-mix + shadow-would-have-fired counters, one place to read BEFORE flipping a
// lane from shadow to apply/enforce. Purely additive to the strip: absent (older daemon) renders
// nothing, present renders one compact row under the loop chips.

const ShadowExitRow: React.FC<{ s: ShadowExitScoreboard }> = ({ s }) => {
  const lanes = Object.entries(s.laneCounts).sort(([, a], [, b]) => b - a);
  if (s.laneTotal === 0 && s.modelRouteShadowTotal === 0 && s.costGateShadowTotal === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-100 px-4 py-1.5 text-[10px] text-gray-500 dark:border-gray-900 dark:text-gray-400"
      title="Shadow-exit scoreboard: what the fleet would do if a shadow-mode lane/decision were flipped to apply/enforce — read this before flipping one."
    >
      <span className="font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Shadow exits</span>
      {lanes.length > 0 && (
        <span>
          lanes:{' '}
          {lanes.map(([lane, count], i) => (
            <span key={lane}>
              {i > 0 ? ', ' : ''}
              {lane} {count}
            </span>
          ))}
        </span>
      )}
      <span title="Model-route decisions made in SHADOW mode that would have escalated to the frontier model">
        model-route would-escalate: {ratioLabel(s.modelRouteShadowWouldEscalate, s.modelRouteShadowTotal)}
      </span>
      <span title="Cost-gate verdicts fired OUTSIDE enforce mode that would have asked/denied">
        cost-gate would-ask/deny: {ratioLabel(s.costGateShadowWouldAct, s.costGateShadowTotal)}
      </span>
    </div>
  );
};

// ─── capacity chip (GRAPH-FOLD.md §1 "Fleet health" fold: a header now-scalar, not a lane) ──────
//
// Fleet health (`/api/governance`) answers one question — "can I throw more work at the fleet, or
// is it about to choke?" (the spawn gate) — which is a SCALAR, not a time series, so it belongs in
// the header strip rather than its own page. `computeCapacity` (insights.ts) already derives the
// 3-state verdict + mem/load percentages from governance+usage for the deleted AttentionPanel; this
// chip is the same synthesis, just given a permanent home next to the loop chips.

const CAPACITY_TONE = { healthy: 'success', warn: 'warn', critical: 'critical' } as const;

const CapacityChip: React.FC<{ capacity: CapacitySummary; ncpu?: number; costUsd?: number }> = ({ capacity, ncpu, costUsd }) => {
  const t = toneClasses(CAPACITY_TONE[capacity.verdict]);
  const title = [
    capacity.headline,
    `Daemon memory: ${Math.round(capacity.memPct)}% of ceiling`,
    `Host load: ${Math.round(capacity.loadPct)}% of ${ncpu ?? '?'}-CPU ceiling`,
    costUsd != null ? `Recent spend: $${costUsd.toFixed(2)}` : '',
    capacity.nextLimit ? `Next limit: ${capacity.nextLimit}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div
      className={`group relative flex flex-shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 ${t.border} ${t.softBg}`}
      title={title}
    >
      <Gauge className={`h-3.5 w-3.5 flex-shrink-0 ${t.text}`} aria-hidden="true" />
      <div className="flex min-w-0 flex-col leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
            {capacityFractionLabel(capacity.used, capacity.cap)}
          </span>
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${t.text}`}>
            {capacity.verdict === 'healthy' ? 'flowing' : capacity.verdict === 'warn' ? 'at cap' : 'throttled'}
          </span>
        </div>
        {/* Compact mem/load line is always visible (a single glance answers "why"); the hover
            `title` above adds the full breakdown (spend, next limit) without more always-on chrome —
            this chip is a header scalar, not a dashboard. */}
        <span className="max-w-[13rem] truncate text-[10px] text-gray-500 dark:text-gray-400">
          mem {Math.round(capacity.memPct)}% · load {Math.round(capacity.loadPct)}%
        </span>
      </div>
    </div>
  );
};

// ─── needs-you glow badge (GRAPH-FOLD.md §6g) ────────────────────────────────
//
// "count persists in nav badge + FactoryStatusStrip on every view" — the Fleet roster's NEEDS
// YOU count must stay visible even while looking at Tasks/Capabilities/Graph, not just while the
// Fleet view itself is open, so a blocked agent can never quietly wait off-screen. Same synthesis
// (`attentionItems`, minus the calm `land-ready` rows) the Fleet roster groups by.
const NeedsYouBadge: React.FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  return (
    <span className="relative flex flex-shrink-0 items-center" title={`${count} agent${count === 1 ? '' : 's'} need you`}>
      <span className="absolute inset-0 animate-ping rounded-full bg-red-400 opacity-60" aria-hidden="true" />
      <span className="relative flex items-center gap-1 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
        <Bell className="h-3 w-3" aria-hidden="true" />
        {count} need{count === 1 ? 's' : ''} you
      </span>
    </span>
  );
};

// ─── strip ───────────────────────────────────────────────────────────────────

export const FactoryStatusStrip: React.FC = () => {
  const { agents } = useTaskContext();
  const [data, setData] = useState<FactoryStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [gov, setGov] = useState<GovernancePayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);

  const capacity = useMemo(() => computeCapacity(gov), [gov]);
  const needsYouCount = useMemo(() => {
    const collisions = detectCollisions(usage?.runs, agents);
    return attentionItems({ agents, capacity, collisions }).filter((i) => i.kind !== 'land-ready').length;
  }, [agents, usage?.runs, capacity]);

  const load = useCallback(async () => {
    try {
      const s = await apiJson<FactoryStatus>('/api/factory/status');
      if (s && Array.isArray(s.loops)) {
        setData(s);
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadCapacity = useCallback(async () => {
    const [g, u] = await Promise.all([
      apiJson<GovernancePayload>('/api/governance').catch(() => null),
      apiJson<UsagePayload>('/api/usage?limit=200').catch(() => null),
    ]);
    setGov(g);
    setUsage(u);
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 7_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    void loadCapacity();
    const interval = setInterval(() => void loadCapacity(), 10_000);
    return () => clearInterval(interval);
  }, [loadCapacity]);

  // Loading: keep the bar height stable, no flash.
  if (!loaded && !data) {
    return (
      <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 py-2">
        <div className="h-6 w-64 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex-shrink-0 border-b border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/20 px-4 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-red-700 dark:text-red-300">
          <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          Factory status unreachable — the daemon may be down.
          <button onClick={() => void load()} className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-red-100 dark:hover:bg-red-900/40" aria-label="Retry">
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const overall = STATUS_META[data.overall];
  const notArmedCount = data.loops.filter((l) => l.status === 'not-armed').length;
  const landBlocked = landBlockedLine(data);

  return (
    <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      {/* "Fleet cannot land" banner — the loudest row when a retryable refusal (dirty main) is live,
          because EVERY auto-land is being refused and the learning ledgers are starved until it clears
          (research-sirvir/01-recording-unlock, part 2). */}
      {landBlocked && (
        <div className="flex items-center gap-2 border-b border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/20 px-4 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
          <span className="min-w-0 truncate text-xs font-semibold text-red-700 dark:text-red-300" title={landBlocked}>
            {landBlocked}
          </span>
        </div>
      )}
      {/* Headline row — always visible. */}
      <div className="flex items-center gap-2.5 px-4 py-2">
        <Activity className="h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden="true" />
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
          {overall.ping && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${overall.dot}`} />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${overall.dot} ${overall.breathe ? 'animate-pulse' : ''}`} />
        </span>
        <span className="min-w-0 truncate text-xs font-semibold text-gray-900 dark:text-gray-100">
          {overallHeadline(data)}
        </span>
        {notArmedCount > 0 && (
          <span className="hidden flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 sm:inline">
            {notArmedCount} loop{notArmedCount === 1 ? '' : 's'} not fueled
          </span>
        )}
        <NeedsYouBadge count={needsYouCount} />
        <div className="ml-auto flex items-center gap-2">
          {gov && <CapacityChip capacity={capacity} ncpu={gov.health?.sample?.ncpu} costUsd={usage?.costUsd} />}
          <button
            onClick={() => void load()}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            title="Refresh"
            aria-label="Refresh factory status"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse loop details' : 'Expand loop details'}
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Per-loop chips — horizontally scrollable, never wraps the page. */}
      {expanded && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-2.5 scrollbar-custom">
          {data.loops.map((loop) => (
            <LoopChip key={loop.loop} report={loop} />
          ))}
        </div>
      )}

      {/* Shadow-exit scoreboard — always visible when present, independent of the expand toggle (a
          one-line trust signal, not per-loop detail). */}
      {data.shadowExits && <ShadowExitRow s={data.shadowExits} />}
    </div>
  );
};
