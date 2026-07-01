/**
 * OmpGraphPanel — the "living dashboard" view: fetches the normalized GraphDoc
 * from /api/graph and renders it as an interactive multi-track temporal canvas
 * (GraphCanvas). Range presets refetch; the canvas itself handles pan/zoom/hover.
 *
 * This is the first renderer over the omp-graph schema. Today it shows the
 * omp-squad adapters (git + receipts + automation); every future source (Stripe,
 * Calendar, Plane, CRM) lights up here for free the moment its adapter is added.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Waypoints, RefreshCw, Sparkles, MousePointer2 } from 'lucide-react';
import { apiJson } from '../lib/api';
import { PanelShell, VerdictBadge } from './ui';
import { GraphCanvas } from '../omp-graph/GraphCanvas';
import type { GraphDoc } from '../omp-graph/types';

const RANGES = [7, 14, 30] as const;

/** Sum a bars/series track by id, or count a spans/events track. */
function trackTotal(doc: GraphDoc | null, id: string): number {
  const t = doc?.tracks.find((tr) => tr.id === id);
  if (!t) return 0;
  if (t.type === 'bars') return t.bins.reduce((a, b) => a + b.v, 0);
  if (t.type === 'series') return t.points.reduce((a, p) => a + p.v, 0);
  if (t.type === 'spans') return t.spans.length;
  if (t.type === 'events') return t.marks.length;
  return t.segments.length;
}

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">{value}</span>
    <span className="text-[10px] uppercase tracking-widest text-gray-400">{label}</span>
  </div>
);

export const OmpGraphPanel: React.FC = () => {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [future, setFuture] = useState(false);
  const [doc, setDoc] = useState<GraphDoc | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await apiJson<GraphDoc>(`/api/graph?days=${days}${future ? '&future=3' : ''}`);
      setDoc(d);
      setError('');
    } catch {
      setError('Could not reach the daemon for graph data.');
    } finally {
      setLoaded(true);
    }
  }, [days, future]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => clearInterval(iv);
  }, [load]);

  const totals = useMemo(
    () => ({
      commits: trackTotal(doc, 'git.commits'),
      churn: trackTotal(doc, 'git.churn'),
      cost: trackTotal(doc, 'receipts.cost'),
      sessions: trackTotal(doc, 'receipts.sessions'),
      milestones: trackTotal(doc, 'git.milestones'),
    }),
    [doc],
  );

  const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${Math.round(n)}`);
  const hasData = doc ? doc.tracks.some((t) => (t.type === 'bars' ? t.bins.some((b) => b.v > 0) : t.type === 'series' ? t.points.some((p) => p.v > 0) : t.type === 'spans' ? t.spans.length : t.type === 'events' ? t.marks.length : t.segments.length)) : false;

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict="healthy">{doc ? `${doc.sources.length} sources · ${doc.tracks.length} tracks` : 'living dashboard'}</VerdictBadge>
    </span>
  );

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      title="Refresh"
      aria-label="Refresh graph data"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell icon={<Waypoints className="h-4 w-4 text-orange-500" aria-hidden="true" />} title="Graph" subtitle={subtitle} actions={refresh}>
      {!loaded && !error && (
        <div className="space-y-2 animate-pulse" aria-label="Loading graph">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div key={n} className="h-4 rounded bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {loaded && error && (
        <div role="alert" className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loaded && !error && doc && (
        <>
          {/* controls + totals */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Range</span>
              <div className="flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    onClick={() => setDays(r)}
                    className={`px-2.5 py-1 text-xs font-medium tabular-nums transition-colors ${days === r ? 'bg-orange-500 text-white' : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                    aria-pressed={days === r}
                  >
                    {r}d
                  </button>
                ))}
              </div>
              <button
                onClick={() => setFuture((v) => !v)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${future ? 'border-cyan-500 bg-cyan-500/15 text-cyan-600 dark:text-cyan-300' : 'border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                aria-pressed={future}
                title="Extend the window 3 days ahead for upcoming meetings / renewals (once those adapters land)"
              >
                + upcoming
              </button>
            </div>
            <div className="flex items-center gap-4">
              <Stat label="commits" value={fmtK(totals.commits)} />
              <Stat label="churned" value={fmtK(totals.churn)} />
              <Stat label="spend" value={`$${Math.round(totals.cost)}`} />
              <Stat label="runs" value={fmtK(totals.sessions)} />
              <Stat label="milestones" value={fmtK(totals.milestones)} />
            </div>
          </div>

          {hasData ? (
            <>
              <GraphCanvas doc={doc} />
              <div className="flex items-center gap-2 px-1 text-[11px] text-gray-400">
                <MousePointer2 className="h-3 w-3" aria-hidden="true" />
                Scroll to zoom time · drag to pan · hover to read every track · click a group label to collapse it
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20 px-6 py-8 text-center">
              <Sparkles className="h-7 w-7 text-emerald-400" aria-hidden="true" />
              <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">No activity in the last {days} days</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">git, receipts, and automation adapters found nothing to chart yet.</div>
            </div>
          )}
        </>
      )}
    </PanelShell>
  );
};
