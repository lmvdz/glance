/**
 * Heat map panel — fetches GET /api/heat and renders a per-file/per-repo heat view.
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw, Thermometer } from 'lucide-react';
import { apiJson } from '../lib/api';

interface HeatEntry {
  path?: string;
  file?: string;
  repo?: string;
  score?: number;
  count?: number;
  lastAt?: number;
  [key: string]: unknown;
}

type HeatResponse = HeatEntry[] | Record<string, unknown>;

function ago(ts?: number): string {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function heatColor(score?: number): string {
  if (score == null) return 'bg-gray-200 dark:bg-gray-700';
  if (score >= 80) return 'bg-red-500';
  if (score >= 60) return 'bg-orange-400';
  if (score >= 40) return 'bg-amber-400';
  if (score >= 20) return 'bg-yellow-300';
  return 'bg-emerald-400';
}

export const HeatPanel: React.FC = () => {
  const [data, setData] = useState<HeatResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const result = await apiJson<HeatResponse>('/api/heat');
      setData(result);
      setError('');
    } catch {
      setError('Could not load heat data from the daemon.');
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => { void load(); }, []);

  const entries: HeatEntry[] = Array.isArray(data) ? data : [];
  const maxScore = entries.reduce((m, e) => Math.max(m, e.score ?? e.count ?? 0), 0) || 1;

  return (
    <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-3 flex-shrink-0 bg-white dark:bg-gray-950">
        <div className="flex items-center gap-2">
          <Thermometer className="h-4 w-4 text-orange-500" aria-hidden="true" />
          <div>
            <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Heat map</h1>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Files and repos sorted by activity heat score</p>
          </div>
        </div>
        <button onClick={() => { setLoaded(false); void load(); }} className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500" title="Refresh" aria-label="Refresh">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-custom">
        {!loaded && !error && (
          <div className="space-y-2 animate-pulse">
            {[1, 2, 3, 4, 5].map((n) => <div key={n} className="h-10 rounded-lg bg-gray-100 dark:bg-gray-800" />)}
          </div>
        )}
        {loaded && error && (
          <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>
        )}
        {loaded && !error && entries.length === 0 && data !== null && !Array.isArray(data) && (
          // data is a plain object — render as key/value table
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-widest text-gray-400">Heat data</div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800 text-xs">
              {Object.entries(data as Record<string, unknown>).map(([key, val]) => (
                <div key={key} className="flex items-start gap-3 px-4 py-2">
                  <span className="font-mono text-gray-500 dark:text-gray-400 w-32 flex-shrink-0">{key}</span>
                  <span className="text-gray-900 dark:text-gray-100 break-all">{JSON.stringify(val)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {loaded && !error && entries.length === 0 && Array.isArray(data) && (
          <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-800 p-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No heat data available yet.
          </div>
        )}
        {entries.length > 0 && (
          <div className="space-y-1">
            {entries.map((e, i) => {
              const label = e.path ?? e.file ?? e.repo ?? `entry-${i}`;
              const score = e.score ?? e.count ?? 0;
              const pct = (score / maxScore) * 100;
              return (
                <div key={i} className="group flex items-center gap-3 rounded-lg border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2 hover:border-gray-200 dark:hover:border-gray-700 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-xs font-medium text-gray-800 dark:text-gray-200" title={String(label)}>{String(label)}</div>
                    {e.repo && e.repo !== label && <div className="text-[10px] text-gray-400 truncate">{String(e.repo)}</div>}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="relative h-2 w-20 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <div className={`h-full rounded-full transition-[width] ${heatColor(score)}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-8 text-right text-[11px] font-mono text-gray-600 dark:text-gray-300">{score}</span>
                    {e.lastAt && <span className="text-[10px] text-gray-400 w-16 text-right">{ago(e.lastAt)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
};
