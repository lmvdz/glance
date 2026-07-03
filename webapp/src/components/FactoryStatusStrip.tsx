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

import React, { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronDown, RefreshCw } from 'lucide-react';
import { apiJson } from '../lib/api';
import {
  STATUS_META,
  overallHeadline,
  loopReasonLine,
  fmtSince,
  type FactoryStatus,
  type FactoryLoopReport,
} from '../lib/factoryStatus';

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

// ─── strip ───────────────────────────────────────────────────────────────────

export const FactoryStatusStrip: React.FC = () => {
  const [data, setData] = useState<FactoryStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(true);

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

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 7_000);
    return () => clearInterval(interval);
  }, [load]);

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

  return (
    <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
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
        <div className="ml-auto flex items-center gap-1">
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
    </div>
  );
};
