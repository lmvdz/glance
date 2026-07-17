/**
 * AdoptionPanel — the dogfood adoption counters made visible, as a compact band inside the Graph
 * view (FLEET PULSE). The daily-driver meta calls casual sessions / prompts / push-taps per day "the
 * real success metric" of the experiment, yet they rendered nowhere; this is the surface that makes
 * the adoption gate legible at a glance.
 *
 * Kept deliberately small (a three-tile number+sparkline row, not a page): it's a sub-header on the
 * Graph, not its own view. `AdoptionStripView` is the pure presentational half (renderToStaticMarkup-
 * testable, no fetch/timers); `AdoptionStrip` is the thin polling container OmpGraphPanel mounts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import { apiJson } from '../lib/api';
import { StatTile } from './ui';
import { ADOPTION_METRICS, isAdoptionCounters, isAdoptionEmpty, metricSummary, type AdoptionCounters } from '../lib/adoption';

/** Sparkline window. 14 days gives the trend enough shape to read while the headline number stays
 *  "today"; the weekly drain still reads its own 7-day sums server-side. */
const WINDOW_DAYS = 14;

export interface AdoptionStripViewProps {
  counters: AdoptionCounters | null;
  loading: boolean;
  error: boolean;
  onRefresh?: () => void;
  /** Injectable for tests; defaults to now. */
  now?: number;
  days?: number;
}

const Band: React.FC<{ children: React.ReactNode; actions?: React.ReactNode }> = ({ children, actions }) => (
  <div className="flex flex-shrink-0 flex-col gap-2 border-b border-gray-200 px-4 py-2.5 dark:border-gray-800">
    <div className="flex items-center gap-2">
      <TrendingUp className="h-3.5 w-3.5 flex-shrink-0 text-orange-500" aria-hidden="true" />
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Adoption · last {WINDOW_DAYS} days</h2>
      <span className="text-[10px] text-gray-400 dark:text-gray-500">the dogfood success metric</span>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
    {children}
  </div>
);

/** Pure presentational strip — every state, no data fetching. */
export const AdoptionStripView: React.FC<AdoptionStripViewProps> = ({ counters, loading, error, onRefresh, now, days = WINDOW_DAYS }) => {
  if (loading && !counters) {
    return (
      <Band>
        <div className="flex gap-2" aria-hidden="true">
          {ADOPTION_METRICS.map((m) => (
            <div key={m.key} className="h-[68px] min-w-[140px] flex-1 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      </Band>
    );
  }

  if (error && !counters) {
    return (
      <Band
        actions={
          onRefresh && (
            <button
              onClick={onRefresh}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              aria-label="Retry loading adoption counters"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
            </button>
          )
        }
      >
        <p className="text-xs text-gray-500 dark:text-gray-400" role="status">
          Adoption counters unreachable — the daemon may be down.
        </p>
      </Band>
    );
  }

  if (isAdoptionEmpty(counters, days, now)) {
    return (
      <Band>
        <p className="text-xs text-gray-500 dark:text-gray-400" role="status">
          No casual usage captured yet. Start a session with <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-800">glance here</code> to begin dogfooding — sessions, prompts, and push-taps will trend here.
        </p>
      </Band>
    );
  }

  // counters is non-null here (isAdoptionEmpty(null) short-circuits above).
  const c = counters as AdoptionCounters;
  return (
    <Band>
      <div className="flex flex-wrap gap-2">
        {ADOPTION_METRICS.map((m) => {
          const s = metricSummary(c[m.key], days, now);
          return (
            <div key={m.key} title={m.hint} className="flex min-w-[140px] flex-1">
              <StatTile
                label={m.label}
                value={<span className="tabular-nums">{s.today}</span>}
                sub={<span className="tabular-nums">{s.total} in {days}d · peak {s.peak}</span>}
                spark={s.series}
                tone={s.total > 0 ? 'info' : 'neutral'}
              />
            </div>
          );
        })}
      </div>
    </Band>
  );
};

/** Polling container — mounted inside OmpGraphPanel's header stack. */
export const AdoptionStrip: React.FC = () => {
  const [counters, setCounters] = useState<AdoptionCounters | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const raw = await apiJson<unknown>('/api/adoption');
      // Guard at the boundary: an old daemon (no /api/adoption) 404s → thrown → error; a degenerate
      // 200 body that isn't counters coerces to null → the empty state, not a crash.
      setCounters(isAdoptionCounters(raw) ? raw : null);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  return <AdoptionStripView counters={counters} loading={loading} error={error} onRefresh={() => void load()} />;
};
