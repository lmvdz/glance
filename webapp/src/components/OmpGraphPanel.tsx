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
import { PageContextScope } from '../context/PageContext';
import { deriveGraphPageContext } from '../lib/pageContextDerive';
import { VerdictBadge } from './ui';
import FleetPulseCanvas, { type DepthMetric, type DepthWeek } from '../omp-graph/FleetPulseCanvas';
import Inspector from '../omp-graph/Inspector';
import { buildPulseModel, hourBins } from '../omp-graph/pulse-model';
import { normalizeAttribution, normalizeGraphDoc } from '../omp-graph/normalize';
import { mergeGraphDocs } from '../omp-graph/merge';
import { trackCollisions, type CollisionTrackMap } from '../omp-graph/collision-track';
import type { InspectSel } from '../omp-graph/inspect';
import type { AttributionDoc, GraphDocWire, ProvenanceDoc } from '../omp-graph/types';
import { detectCollisions, type Collision, type UsagePayload } from '../lib/insights';

const RANGES = [7, 14, 30] as const;
const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
/** Older-history chunk per lazy load — under the daemon's 32-day per-request cap. */
const OLDER_CHUNK_MS = 30 * DAY_MS;
/** How far back dragging can pull history before it stops (a full year). */
const MAX_HISTORY_MS = 365 * DAY_MS;

export const OmpGraphPanel: React.FC = () => {
  const { agents } = useTaskContext();
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [doc, setDoc] = useState<GraphDocWire | null>(null);
  const [attribution, setAttribution] = useState<AttributionDoc | null>(null);
  const [error, setError] = useState('');
  const [empty, setEmpty] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState<InspectSel | null>(null);
  const [trace, setTrace] = useState<ProvenanceDoc | null>(null);
  const [viz, setViz] = useState<'flat' | 'depth'>('flat');
  const [depthMetric, setDepthMetric] = useState<DepthMetric>('commits');
  const [depthWeeks, setDepthWeeks] = useState<DepthWeek[] | null>(null);
  // Older history, kept SEPARATE from the polled recent window. It is fetched once per drag-back
  // and never re-polled, and the recent `doc` covers a disjoint (later) range — so merging the two
  // never double-counts. Critically, this is why the cumulative is stable: the recent window is
  // REPLACED each poll (not accumulated). GraphDoc cost bins are bucketed relative to range.start
  // (src/omp-graph/schema.ts `bucketSums`), which advances ~20s per poll, so re-merging a fresh
  // recent window into a prior one every poll would stack shifted-but-duplicate cost bins and make
  // the cumulative climb without bound.
  const [older, setOlder] = useState<GraphDocWire | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Bumped only on deliberate view changes (preset switch / refresh) so the canvas
  // re-centers then — NOT on the 20s poll or a lazy history extend, which must leave
  // the user's pan/zoom untouched.
  const [resetKey, setResetKey] = useState(0);
  // Collision marker (GRAPH-FOLD.md §2/§4/§5): ≥2 LIVE agents holding the same path. Polled
  // independently of the graph window (usage.runs has no time-range param worth tying to `days`),
  // then gated through the min-dwell tracker so a sub-second overlap never flashes on AGENT RUNS.
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [collisions, setCollisions] = useState<Collision[]>([]);
  const collisionTrackRef = useRef<CollisionTrackMap>(new Map());

  // a slow response for an old range must not overwrite a newer one
  const reqId = useRef(0);
  const loadingOlderRef = useRef(false);
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
        // /api/graph can answer 200 with a degenerate body (an empty org / no repo scoped),
        // which parses fine but omits required fields. Coerce at the boundary so a partial
        // doc becomes null (→ empty state) instead of crashing buildPulseModel on doc.range.
        const nd = normalizeGraphDoc(d);
        // REPLACE, never accumulate: the recent window is authoritative each poll. Accumulating it
        // would double-count range-relative cost bins (see the `older` note above). Loaded history
        // lives in `older` and is merged in only at render.
        setDoc(nd);
        setAttribution(normalizeAttribution(a));
        setEmpty(nd ? '' : 'No graph data for this workspace yet — add a repo to your workspace to populate the pulse.');
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
    // A preset change is a fresh window: drop any stitched history and re-center the view.
    setOlder(null);
    setResetKey((k) => k + 1);
    void load();
    const iv = setInterval(() => void load(), 20_000);
    return () => {
      clearInterval(iv);
      reqId.current++;
    };
  }, [load]);

  // Lazy history: called when a leftward drag reaches the loaded start edge. Fetches one bounded
  // older window and stitches it onto the FRONT of `older` (a range strictly before the recent
  // window), without touching the view — so the user keeps dragging into the newly-available past.
  const earliestLoaded = older?.range.start ?? doc?.range.start;
  const atHistoryLimit = earliestLoaded != null && earliestLoaded <= Date.now() - MAX_HISTORY_MS;
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const end = older?.range.start ?? doc?.range.start;
    if (end == null || end <= Date.now() - MAX_HISTORY_MS) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const start = Math.max(Date.now() - MAX_HISTORY_MS, end - OLDER_CHUNK_MS);
    try {
      const chunk = normalizeGraphDoc(await apiJson<GraphDocWire>(`/api/graph?start=${Math.round(start)}&end=${Math.round(end)}`));
      if (chunk) setOlder((prev) => (prev ? mergeGraphDocs(chunk, prev) : chunk));
    } catch {
      /* transient — the drag can retry */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [older?.range.start, doc?.range.start]);

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

  // Merge loaded history under the fresh recent window ONLY here, at render. `older` covers a
  // strictly-earlier, disjoint range, so this never double-counts — and because `doc` is replaced
  // (not accumulated) each poll, the cumulative stays stable.
  const model = useMemo(() => {
    if (!doc) return null;
    return buildPulseModel(older ? mergeGraphDocs(older, doc) : doc, agents);
  }, [older, doc, agents]);

  // Poll /api/usage on the same cadence the (dying) Heat/Federation/Attention panels already use —
  // independent of the graph window, since usage.runs isn't range-scoped by `days`.
  useEffect(() => {
    let live = true;
    const loadUsage = async (): Promise<void> => {
      try {
        const u = await apiJson<UsagePayload>('/api/usage?limit=200');
        if (live) setUsage(u);
      } catch {
        /* transient — next poll retries */
      }
    };
    void loadUsage();
    const iv = setInterval(() => void loadUsage(), 10_000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, []);

  // detectCollisions already scopes to the LIVE roster (LIVE_STATUSES in lib/insights.ts), so a
  // stale/un-reaped lease on a removed agent can never seed a collision here — the "code
  // defensively" half of the guard. trackCollisions adds the min-dwell gate: a fresh overlap must
  // persist before it's allowed to render (the "don't flash" half).
  const rawCollisions = useMemo(() => detectCollisions(usage?.runs, agents), [usage, agents]);
  useEffect(() => {
    const { confirmed, next } = trackCollisions(rawCollisions, collisionTrackRef.current, Date.now());
    collisionTrackRef.current = next;
    setCollisions(confirmed);
  }, [rawCollisions]);

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
        className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        title="Force refresh (bypass cache)"
        aria-label="Refresh graph data"
      >
        <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
      </button>
    </div>
  );

  // PageContext (Feature 2 D1): the time window, FLAT/RHYTHM mode, and the inspector's current
  // kind+id — all local state this component already owns (no duplicate fetch).
  const pageContext = useMemo(() => deriveGraphPageContext({ days, viz, sel }), [days, viz, sel]);

  return (
    <PageContextScope value={pageContext}>
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
        {!error && !model && empty && (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-gray-500 dark:text-gray-400">{empty}</div>
        )}
        {!error && !model && !empty && <div className="flex flex-1 items-center justify-center text-sm text-gray-400">Loading…</div>}
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
            resetKey={resetKey}
            onReachStart={loadOlder}
            loadingOlder={loadingOlder}
            atHistoryLimit={atHistoryLimit}
            collisions={collisions}
          />
        )}
        {model && sel && <Inspector sel={sel} model={model} attribution={attribution} onClose={close} onTrace={setTrace} />}
      </div>
    </main>
    </PageContextScope>
  );
};
