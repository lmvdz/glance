/**
 * HeatPanel — "Activity & hotspots" panel.
 *
 * LEADS WITH A VERDICT: predicts merge conflicts (≥2 live agents editing the
 * same file) BEFORE they happen, then surfaces churn hotspots as a
 * GitHub-contribution-style matrix instead of the raw JSON array.
 *
 * Primary value:
 *   1. Collision Callout  — files being edited by multiple live agents right now.
 *   2. Churn Callout      — the single loudest thrash hotspot (≥3 agents).
 *   3. HeatGrid           — scannable per-file/per-day matrix of the top hotspots.
 *   4. Raw heat data      — collapsed <details> for power users who want the JSON.
 *
 * Shared foundation (imported, not reimplemented):
 *   - detectCollisions / churnHotspots / HeatPayload / UsageRun from insights
 *   - PanelShell / VerdictBadge / Callout / SectionCard / HeatGrid / relativeAge from ./ui
 *   - apiJson from ../lib/api
 *   - agents from TaskContext (live roster, same as AttentionPanel)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Flame, RefreshCw, Users } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import {
  detectCollisions,
  churnHotspots,
  type HeatPayload,
  type UsagePayload,
} from '../lib/insights';
import { PanelShell, VerdictBadge, Callout, SectionCard, HeatGrid } from './ui';
import { focusTaskSearch } from '../lib/jump';

// ──────────────────────────────── helpers ────────────────────────────────────

/** Shorten a long path to the last two segments for tight display. */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Trim the path to a reasonable column width in the grid label. */
function gridLabel(p: string): string {
  // keep up to 3 segments for the grid (wider than callout)
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join('/')}`;
}

// ──────────────────────────────── component ──────────────────────────────────

/**
 * Exported for renderToStaticMarkup-based tests.  The panel is purely a
 * display/orchestration layer; all logic lives in insights.ts.
 */
export const HeatPanel: React.FC = () => {
  const { agents } = useTaskContext();

  const [heat, setHeat] = useState<HeatPayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [h, u] = await Promise.all([
        apiJson<HeatPayload>('/api/heat').catch((): null => null),
        apiJson<UsagePayload>('/api/usage?limit=200').catch((): null => null),
      ]);
      setHeat(h);
      setUsage(u);
      setError('');
    } catch {
      setError('Could not reach the daemon for heat data.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  // ── derived signals ──────────────────────────────────────────────────────

  const collisions = useMemo(
    () => detectCollisions(usage?.runs, agents),
    [usage?.runs, agents],
  );

  const hotspots = useMemo(
    () => churnHotspots(heat, usage?.runs, 8),
    [heat, usage?.runs],
  );

  // Top churn hotspot flagged for splitting: needs ≥3 distinct agents.
  const topChurn = hotspots.find((h) => h.agentCount >= 3) ?? null;

  // ── verdict ──────────────────────────────────────────────────────────────

  const hasCollisions = collisions.length > 0;
  const hasChurn = topChurn !== null;

  const verdictKind: 'critical' | 'warn' | 'healthy' = hasCollisions
    ? 'critical'
    : hasChurn
      ? 'warn'
      : 'healthy';

  const verdictText = hasCollisions
    ? `${collisions.length} collision risk${collisions.length === 1 ? '' : 's'}${hasChurn ? ' · 1 churn hotspot' : ''}`
    : hasChurn
      ? '1 churn hotspot'
      : 'No contention';

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={verdictKind}>{verdictText}</VerdictBadge>
    </span>
  );

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      title="Refresh"
      aria-label="Refresh heat data"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  // ── grid rows ─────────────────────────────────────────────────────────────

  const gridRows = hotspots.map((hs) => ({
    label: gridLabel(hs.path),
    daily: hs.daily,
    note: hs.agentCount > 0 ? `${hs.agentCount} agent${hs.agentCount === 1 ? '' : 's'}` : undefined,
  }));

  const days = heat?.days ?? [];

  return (
    <PanelShell
      icon={<Flame className="h-4 w-4 text-orange-500" aria-hidden="true" />}
      title="Activity &amp; hotspots"
      subtitle={subtitle}
      actions={refresh}
    >
      {/* Loading skeleton */}
      {!loaded && !error && (
        <div className="space-y-3 animate-pulse" aria-label="Loading heat data">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {/* Error */}
      {loaded && error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {/* Main body */}
      {loaded && !error && (
        <>
          {/* ── COLLISION CALLOUT (headline) ─────────────────────────────── */}
          {hasCollisions && (
            <Callout
              tone="critical"
              title={`${collisions.length} file${collisions.length === 1 ? '' : 's'} being edited by multiple live agents — likely conflict at land`}
            >
              <ul className="mt-2 space-y-2" aria-label="Collision details">
                {collisions.map((c) => (
                  <li
                    key={c.file}
                    className="flex items-start justify-between gap-3 rounded-md border border-red-200/60 dark:border-red-900/40 bg-white/60 dark:bg-gray-950/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div
                        className="truncate text-xs font-mono font-medium text-gray-800 dark:text-gray-200"
                        title={c.file}
                      >
                        {shortPath(c.file)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {c.agents.map((a) => (
                          <span
                            key={a.id}
                            className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300"
                          >
                            <Users className="h-2.5 w-2.5" aria-hidden="true" />
                            {a.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => focusTaskSearch()}
                      className="flex-shrink-0 rounded-md border border-red-200 dark:border-red-800 bg-white/70 dark:bg-gray-900/50 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 transition-colors hover:bg-white dark:hover:bg-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      aria-label={`View agents editing ${shortPath(c.file)}`}
                    >
                      View agents
                    </button>
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {/* ── CHURN CALLOUT ────────────────────────────────────────────── */}
          {hasChurn && (
            <Callout
              tone="warn"
              title={
                <>
                  🔥{' '}
                  <span className="font-mono">{shortPath(topChurn!.path)}</span>{' '}
                  is your churn hotspot
                </>
              }
            >
              {topChurn!.agentCount} agents touched it — repeated thrash here often means it wants splitting.
            </Callout>
          )}

          {/* ── CALM EMPTY STATE ─────────────────────────────────────────── */}
          {!hasCollisions && !hasChurn && hotspots.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20 px-6 py-10 text-center">
              <Flame className="h-8 w-8 text-gray-300 dark:text-gray-700" aria-hidden="true" />
              <div className="text-base font-semibold text-gray-600 dark:text-gray-300">
                No hot files in the last window
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                No contention or churn detected — all clear.
              </div>
            </div>
          )}

          {/* ── HEAT GRID ─────────────────────────────────────────────────── */}
          {hotspots.length > 0 && (
            <SectionCard
              title="File activity matrix"
              right={days.length > 0 ? `${days.length} days` : undefined}
            >
              <HeatGrid
                days={days}
                rows={gridRows}
                emptyLabel="No hot files in the last window."
              />
            </SectionCard>
          )}

          {/* ── RAW HEAT DATA (collapsed) ────────────────────────────────── */}
          {heat && (
            <details className="group rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-xs">
              <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 list-none">
                <span className="mr-auto">Raw heat data</span>
                <span className="text-gray-300 dark:text-gray-600 group-open:rotate-180 transition-transform" aria-hidden="true">
                  ▾
                </span>
              </summary>
              <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-600 dark:text-gray-400 leading-relaxed">
                  {JSON.stringify(heat, null, 2)}
                </pre>
              </div>
            </details>
          )}
        </>
      )}
    </PanelShell>
  );
};
