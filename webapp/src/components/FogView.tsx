/**
 * FogView — the comprehension lane's "Fog" nav item (batch-3 review, plans/comprehension/
 * 04-fog-overlay-ui.md + DESIGN.md's "Fog UI" row): the ONLY render site for `HeatTree`'s
 * comprehension-fog overlay.
 *
 * GRAPH-FOLD.md retired the old "Context Heat Graph" page (`HeatPanel.tsx`, deleted) and folded its
 * touch-count heat matrix into the Graph view's other signals — but `HeatTree.tsx`'s fog OVERLAY
 * (concern 04) shipped afterward with no mount point at all: nothing in the app shell ever rendered
 * it with fog mode on, so the operator had no way to reach the tri-state comprehension-debt read
 * (never-seen / seen-current / stale) that the whole comprehension lane exists to surface. This is
 * that mount.
 *
 * Deliberately NOT a resurrection of the old `HeatPanel`'s full "Activity & hotspots" surface — the
 * collision-prediction and flapping-agent callouts it used to carry already live in Needs-you per
 * GRAPH-FOLD §1's "Heat map" row. This view's only job is the fog read: fetch `/api/heat?days=`
 * (the same folder/file touch matrix `HeatTree` always needed to build its tree — fog is an
 * OVERLAY on that shape, not a replacement for it) and hand the tree to `<HeatTree initialFogMode />`,
 * which self-fetches `/api/fog` the moment fog mode is on. `initialFogMode` defaults the toggle ON
 * here (per the design's ask) — the operator can still flip back to plain touch-count heat via
 * HeatTree's own toggle, same affordance it always had.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CloudFog, RefreshCw } from 'lucide-react';
import { apiJson, fetchFog, type FogPayload } from '../lib/api';
import { PageContextScope } from '../context/PageContext';
import { deriveFogPageContext } from '../lib/pageContextDerive';
import { buildHeatTree, initialExpanded } from '../lib/heatmap';
import type { HeatPayload } from '../lib/insights';
import { PanelShell, HeatTree } from './ui';
import { SymptomsCard } from './SymptomsCard';

const RANGES = [7, 14, 30] as const;

export const FogView: React.FC = () => {
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);
  const [heat, setHeat] = useState<HeatPayload | null>(null);
  const [fog, setFog] = useState<FogPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      // Heat and fog refresh TOGETHER on every load (code-review resume finding 6): HeatTree's own
      // self-fetch fires once and caches forever, so this view's 30s auto-reload and its Refresh
      // button must own the fog fetch too or the debt/tri-state overlay goes permanently stale
      // while mounted. Fog failing must not blank the heat tree — it degrades to the last payload.
      const [h, f] = await Promise.allSettled([apiJson<HeatPayload>(`/api/heat?days=${days}`), fetchFog()]);
      if (h.status === 'fulfilled') {
        setHeat(h.value);
        setError('');
      } else {
        setError('Could not reach the daemon for fog data.');
      }
      if (f.status === 'fulfilled') setFog(f.value);
    } finally {
      setLoaded(true);
    }
  }, [days]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const tree = useMemo(() => buildHeatTree(heat?.tree, heat?.days?.length ?? 0), [heat?.tree, heat?.days]);
  const defaultExpanded = useMemo(() => initialExpanded(tree), [tree]);

  // PageContext (Feature 2 D1): the days-of-history window + how many files are in view — the two
  // axes that actually change what's on screen here, mirroring OmpGraphPanel's own scope call.
  const pageContext = useMemo(() => deriveFogPageContext({ days, fileCount: tree.fileCount }), [days, tree.fileCount]);

  const rangeToggle = (
    <div className="flex items-center gap-1" role="group" aria-label="Days of history">
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => setDays(r)}
          aria-pressed={days === r}
          className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            days === r
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          {r}d
        </button>
      ))}
    </div>
  );

  const refresh = (
    <button
      type="button"
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      title="Refresh"
      aria-label="Refresh fog data"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PageContextScope value={pageContext}>
      <PanelShell
        icon={<CloudFog className="h-4 w-4 text-indigo-400" aria-hidden="true" />}
        title="Comprehension fog"
        subtitle="What the fleet changed that nobody has looked at yet"
        actions={
          <div className="flex items-center gap-2">
            {rangeToggle}
            {refresh}
          </div>
        }
      >
        {!loaded && !error && (
          <div className="space-y-3 animate-pulse" aria-label="Loading fog data">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800" />
            ))}
          </div>
        )}

        {loaded && error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {loaded && !error && (
          <HeatTree days={heat?.days ?? []} tree={tree} showPatterns={false} defaultExpanded={defaultExpanded} initialFogMode fogData={fog ?? undefined} />
        )}

        {/* Recurring failure modes (comprehension concern 07) — fed live by units, previously
            reachable only via ⌘K search (which requires knowing what to search for). Browsable
            here because fog and symptoms answer the same operator question: what is going wrong
            that nobody has looked at? */}
        <div className="mt-4">
          <SymptomsCard />
        </div>
      </PanelShell>
    </PageContextScope>
  );
};
