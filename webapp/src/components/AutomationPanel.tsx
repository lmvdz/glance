/**
 * Automation panel — mirrors the legacy UI's "Background automation" view.
 *
 * Fetches GET /api/automation and subscribes to live WS `automation` events.
 * Shows per-loop rollup cards (Scout/Observer/Opportunity/Dispatch) and a
 * recent-events feed below.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Zap } from 'lucide-react';
import { apiJson } from '../lib/api';

interface AutomationEvent {
  at: number;
  loop: string;
  level?: string;
  agent?: string;
  repo?: string;
  llmCalls?: number;
  found?: number;
  filed?: number;
  spawned?: number;
  durationMs?: number;
  detail?: string;
}

interface AutomationRollup {
  loop: string;
  events: number;
  llmCalls: number;
  found: number;
  filed: number;
  spawned?: number;
  errors?: number;
  lastAt: number;
}

interface AutomationResponse {
  events: AutomationEvent[];
  rollup: AutomationRollup[];
}

const AUTO_LOOPS: Record<string, { icon: string; label: string; unit: string; desc: string }> = {
  scout:       { icon: '🔭', label: 'Scout',       unit: 'scans', desc: 'reads agent reasoning → backlog · LLM' },
  observer:    { icon: '🩺', label: 'Observer',    unit: 'ticks', desc: 'audits fleet & gate health · no LLM' },
  opportunity: { icon: '🧩', label: 'Opportunity', unit: 'ticks', desc: 'clusters scout patterns · no LLM' },
  dispatch:    { icon: '🚀', label: 'Dispatch',    unit: 'ticks', desc: 'spawns agents from Plane · no LLM' },
};

const AUTO_WINDOWS: Array<[string, number]> = [['15m', 900_000], ['1h', 3_600_000], ['6h', 21_600_000], ['24h', 86_400_000]];

function ago(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function shortRepo(p?: string): string {
  const parts = String(p ?? '').split('/');
  return parts[parts.length - 1] || (p ?? '');
}

export const AutomationPanel: React.FC = () => {
  const [data, setData] = useState<AutomationResponse>({ events: [], rollup: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [loopFilter, setLoopFilter] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '200', windowMs: String(windowMs) });
    if (loopFilter) params.set('loop', loopFilter);
    try {
      const result = await apiJson<AutomationResponse>(`/api/automation?${params.toString()}`);
      setData(result);
      setError('');
    } catch {
      setError('Could not reach the daemon for automation activity.');
    } finally {
      setLoaded(true);
    }
  }, [windowMs, loopFilter]);

  // Initial load + re-load when filters change
  useEffect(() => {
    setLoaded(false);
    void load();
    // Poll every 10s while the panel is mounted
    const interval = setInterval(() => void load(), 10_000);
    return () => clearInterval(interval);
  }, [load]);

  // Cleanup debounce timer on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const rollupFor = (loop: string): AutomationRollup =>
    data.rollup.find((r) => r.loop === loop) ?? { loop, events: 0, llmCalls: 0, found: 0, filed: 0, spawned: 0, errors: 0, lastAt: 0 };

  const totalLlm = data.rollup.reduce((sum, r) => sum + (r.llmCalls ?? 0), 0);

  const renderRollupCard = (loop: string) => {
    const meta = AUTO_LOOPS[loop];
    if (!meta) return null;
    const r = rollupFor(loop);
    const last = r.lastAt ? `${ago(r.lastAt)} ago` : 'idle';
    return (
      <div key={loop} className="flex-1 min-w-[180px] rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg" aria-hidden="true">{meta.icon}</span>
          <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">{meta.label}</span>
          {r.llmCalls > 0 ? (
            <span className="ml-auto text-[10px] font-semibold rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5">{r.llmCalls} LLM</span>
          ) : (
            <span className="ml-auto text-[10px] font-semibold rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-2 py-0.5">0 LLM</span>
          )}
        </div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{meta.desc}</div>
        <div className="flex flex-wrap gap-3 text-xs text-gray-700 dark:text-gray-300">
          <span><b>{r.events}</b> <span className="text-gray-400">{meta.unit}</span></span>
          <span><b>{r.filed}</b> <span className="text-gray-400">filed</span></span>
          <span><b>{r.found}</b> <span className="text-gray-400">found</span></span>
          {loop === 'dispatch' && <span><b>{r.spawned ?? 0}</b> <span className="text-gray-400">spawned</span></span>}
          {(r.errors ?? 0) > 0 && <span className="text-red-600 dark:text-red-400 font-medium">{r.errors} err</span>}
        </div>
        <div className="mt-2 text-[10px] text-gray-400">last: {last}</div>
      </div>
    );
  };

  const renderEventRow = (e: AutomationEvent, i: number) => {
    const meta = AUTO_LOOPS[e.loop] ?? { icon: '•', label: e.loop, unit: '', desc: '' };
    const who = e.agent ? e.agent : e.repo ? shortRepo(e.repo) : 'fleet';
    const dur = typeof e.durationMs === 'number'
      ? (e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)}s` : `${e.durationMs}ms`)
      : undefined;
    return (
      <div key={i} className="grid grid-cols-[auto_1fr_auto_auto] items-start gap-x-3 gap-y-0.5 border-b border-gray-100 dark:border-gray-800 py-1.5 text-xs last:border-b-0">
        <span className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:text-gray-300" title={meta.label}>{meta.icon} {e.loop}</span>
        <span className="truncate text-gray-700 dark:text-gray-300 font-medium">{who}</span>
        <div className="flex flex-wrap gap-1">
          {e.llmCalls ? <span className="rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">{e.llmCalls} LLM</span> : null}
          {e.found ? <span className="rounded bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-300">{e.found} found</span> : null}
          {e.filed ? <span className="rounded bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-300">{e.filed} filed</span> : null}
          {e.spawned ? <span className="rounded bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-300">{e.spawned} spawned</span> : null}
          {e.level === 'error' && <span className="rounded bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">error</span>}
          {e.level === 'warn' && <span className="rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">warn</span>}
          {!e.llmCalls && !e.found && !e.filed && !e.spawned && e.level !== 'error' && e.level !== 'warn' && <span className="text-gray-400">—</span>}
        </div>
        <span className="text-gray-400 whitespace-nowrap text-[10px]">{dur ? `${dur} · ` : ''}{ago(e.at)} ago</span>
        {e.detail && (
          <span className="col-span-4 whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400 pl-2 text-[11px]">{e.detail}</span>
        )}
      </div>
    );
  };

  return (
    <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-3 flex-shrink-0 bg-white dark:bg-gray-950">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" aria-hidden="true" />
            <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Background automation</h1>
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            What the daemon's loops do on their own · {totalLlm} LLM call{totalLlm === 1 ? '' : 's'} in the last window — Scout is the only one that spends tokens
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value) || 3_600_000)} className="text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label="Rollup window">
            {AUTO_WINDOWS.map(([lbl, ms]) => <option key={ms} value={ms}>{lbl}</option>)}
          </select>
          <select value={loopFilter} onChange={(e) => setLoopFilter(e.target.value)} className="text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label="Filter by loop">
            <option value="">all loops</option>
            {Object.entries(AUTO_LOOPS).map(([key, val]) => <option key={key} value={key}>{val.label}</option>)}
          </select>
          <button onClick={() => void load()} className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500" title="Refresh" aria-label="Refresh">
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-custom space-y-4">
        {/* Rollup cards */}
        <div className="flex flex-wrap gap-3">
          {Object.keys(AUTO_LOOPS).map(renderRollupCard)}
        </div>

        {/* Events feed */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-widest text-gray-400">Recent events</div>
          <div className="px-4 py-2 divide-y divide-gray-100 dark:divide-gray-800">
            {!loaded && !error && (
              <div className="space-y-2 py-2 animate-pulse">
                {[1, 2, 3, 4].map((n) => <div key={n} className="h-5 rounded bg-gray-100 dark:bg-gray-800" />)}
              </div>
            )}
            {loaded && error && (
              <div className="py-4 text-sm text-red-600 dark:text-red-400">{error}</div>
            )}
            {loaded && !error && data.events.length === 0 && (
              <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                No background activity yet. The loops run on a timer once agents and Plane repos are configured.
              </div>
            )}
            {data.events.map((e, i) => renderEventRow(e, i))}
          </div>
        </div>
      </div>
    </main>
  );
};
