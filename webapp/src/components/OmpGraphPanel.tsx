/**
 * OmpGraphPanel — the Graph view: the FLEET PULSE instrument
 * (docs/design/fleet-pulse/DESIGN.md) over live daemon data.
 *
 * This container owns the data plane — GraphDoc (+plan), the harness→model
 * attribution, and the lazy eight weekly windows behind DEPTH mode — plus the
 * inspector split: the canvas and the pane are true flex siblings, so opening
 * details reflows the composition instead of covering it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Waypoints } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import { VerdictBadge } from './ui';
import FleetPulseCanvas, { type DepthMetric, type DepthWeek } from '../omp-graph/FleetPulseCanvas';
import Inspector from '../omp-graph/Inspector';
import { buildPulseModel, hourBins } from '../omp-graph/pulse-model';
import type { InspectSel } from '../omp-graph/inspect';
import type { AttributionDoc, GraphDocWire, ProvenanceDoc } from '../omp-graph/types';

const RANGES = [7, 14, 30] as const;
const WEEK_MS = 7 * 24 * 3_600_000;

export const OmpGraphPanel: React.FC = () => {
  const { agents } = useTaskContext();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [doc, setDoc] = useState<GraphDocWire | null>(null);
  const [attribution, setAttribution] = useState<AttributionDoc | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState<InspectSel | null>(null);
  const [trace, setTrace] = useState<ProvenanceDoc | null>(null);
  const [viz, setViz] = useState<'flat' | 'depth'>('flat');
  const [depthMetric, setDepthMetric] = useState<DepthMetric>('commits');
  const [depthWeeks, setDepthWeeks] = useState<DepthWeek[] | null>(null);

  // a slow response for an old range must not overwrite a newer one
  const reqId = useRef(0);
  const load = useCallback(
    async (opts?: { force?: boolean }) => {
      const id = ++reqId.current;
      if (opts?.force) setRefreshing(true);
      try {
        const [d, a] = await Promise.all([
          apiJson<GraphDocWire>(`/api/graph?days=${days}&future=3${opts?.force ? '&fresh=1' : ''}`),
          apiJson<AttributionDoc>(`/api/graph/attribution?days=${days}`).catch(() => null),
        ]);
        if (id !== reqId.current) return;
        setDoc(d);
        setAttribution(a);
        setError('');
      } catch {
        if (id === reqId.current && !doc) setError('Could not reach the daemon for graph data.');
      } finally {
        if (id === reqId.current) setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doc is only read for the has-data check
    [days],
  );

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => {
      clearInterval(iv);
      reqId.current++;
    };
  }, [load]);

  // DEPTH lazily fetches one real /api/graph window per week row
  useEffect(() => {
    if (viz !== 'depth' || depthWeeks) return;
    let live = true;
    void (async () => {
      const now = Date.now();
      const weeks = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          const end = now - (7 - i) * WEEK_MS;
          const start = end - WEEK_MS;
          try {
            const wdoc = await apiJson<GraphDocWire>(`/api/graph?start=${Math.round(start)}&end=${Math.round(end)}`);
            const week: DepthWeek = {
              label: i === 7 ? 'THIS WEEK' : `WK −${7 - i}`,
              commits: hourBins(wdoc, 'git.commits').slice(0, 168),
              cost: hourBins(wdoc, 'receipts.cost').slice(0, 168),
              churn: hourBins(wdoc, 'git.churn').slice(0, 168),
              nowHour: i === 7 ? Math.min(168, Math.floor((now - start) / 3_600_000)) : undefined,
            };
            return week;
          } catch {
            return { label: `WK −${7 - i}`, commits: new Array(168).fill(0), cost: new Array(168).fill(0), churn: new Array(168).fill(0) } as DepthWeek;
          }
        }),
      );
      if (live) setDepthWeeks(weeks);
    })();
    return () => {
      live = false;
    };
  }, [viz, depthWeeks]);

  const model = useMemo(() => (doc ? buildPulseModel(doc, agents) : null), [doc, agents]);

  const onInspect = useCallback((s: InspectSel) => {
    setSel(s);
    if (s.kind !== 'ticket') setTrace(null);
  }, []);
  const close = useCallback(() => {
    setSel(null);
    setTrace(null);
  }, []);

  const controls = (
    <div className="flex items-center gap-2">
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
        onClick={() => void load({ force: true })}
        className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        title="Force refresh (bypass cache)"
        aria-label="Refresh graph data"
      >
        <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <div className="flex min-w-0 items-center gap-3">
          <Waypoints className="h-4 w-4 flex-shrink-0 text-orange-500" aria-hidden="true" />
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Graph</h1>
          <VerdictBadge verdict="healthy">{doc ? `${doc.sources.length} sources · fleet pulse` : 'living dashboard'}</VerdictBadge>
          <div className="ml-1">{controls}</div>
        </div>
        {model && model.needsCount > 0 && (
          <button
            onClick={() => onInspect({ kind: 'needs' })}
            className="rounded-full border border-red-500/60 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            {model.needsCount} need you
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {error && !model && (
          <div role="alert" className="flex flex-1 items-center justify-center p-4 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!error && !model && <div className="flex flex-1 items-center justify-center text-sm text-gray-400">Loading…</div>}
        {model && (
          <FleetPulseCanvas
            model={model}
            attribution={attribution}
            plan={doc?.plan ?? null}
            repoLabel="glance"
            onInspect={onInspect}
            trace={trace}
            viz={viz}
            onViz={setViz}
            depthWeeks={depthWeeks}
            depthMetric={depthMetric}
            onDepthMetric={setDepthMetric}
          />
        )}
        {model && sel && <Inspector sel={sel} model={model} attribution={attribution} onClose={close} onTrace={setTrace} />}
      </div>
    </main>
  );
};
