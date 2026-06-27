/**
 * Fleet health panel — mirrors the legacy UI's health strip.
 *
 * Fetches GET /api/health and GET /api/version, and uses the WS connection
 * state from TaskContext to show a compact posture summary.
 */

import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';

interface HealthResponse {
  ok: boolean;
  uptimeSec?: number;
  agents?: number;
  projects?: number;
}

interface VersionResponse {
  version?: string;
}

type LoadState<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error' };

function fmtUptime(s?: number): string {
  const sec = Math.max(0, Math.round(Number(s) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

interface CellProps {
  label: string;
  dot: 'ok' | 'warn' | 'bad' | 'info' | '';
  value: string;
  sub?: string;
}

const HealthCell: React.FC<CellProps> = ({ label, dot, value, sub }) => {
  const dotColor = dot === 'ok' ? 'bg-emerald-500' : dot === 'warn' ? 'bg-amber-400' : dot === 'bad' ? 'bg-red-500' : dot === 'info' ? 'bg-blue-400' : 'bg-gray-300';
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 min-w-[140px] flex-1">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</div>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{value}</span>
      </div>
      {sub && <div className="text-[11px] text-gray-500 dark:text-gray-400">{sub}</div>}
    </div>
  );
};

const HealthCellSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex flex-col gap-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 min-w-[140px] flex-1 animate-pulse">
    <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</div>
    <div className="h-5 w-24 rounded bg-gray-200 dark:bg-gray-800" />
  </div>
);

export const FleetHealthPanel: React.FC = () => {
  const { connected, agents } = useTaskContext();
  const [health, setHealth] = useState<LoadState<HealthResponse>>({ status: 'loading' });
  const [version, setVersion] = useState<LoadState<VersionResponse>>({ status: 'loading' });
  const [fetchedAt, setFetchedAt] = useState(0);

  const load = async (force = false) => {
    if (!force && health.status !== 'loading' && Date.now() - fetchedAt < 5000) return;
    setFetchedAt(Date.now());
    const [h, v] = await Promise.all([
      apiJson<HealthResponse>('/api/health').then((d): LoadState<HealthResponse> => ({ status: 'ok', data: d })).catch((): LoadState<HealthResponse> => ({ status: 'error' })),
      apiJson<VersionResponse>('/api/version').then((d): LoadState<VersionResponse> => ({ status: 'ok', data: d })).catch((): LoadState<VersionResponse> => ({ status: 'error' })),
    ]);
    setHealth(h);
    setVersion(v);
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = agents.filter((a) => a.status === 'working').length;
  const needsInput = agents.filter((a) => a.status === 'input' || a.pending.length > 0).length;

  const connCell: CellProps = connected
    ? { label: 'Connection', dot: 'ok', value: 'Live', sub: 'realtime stream connected' }
    : { label: 'Connection', dot: 'bad', value: 'Offline', sub: 'reconnecting…' };

  let verdict = 'All systems nominal';
  let verdictColor = 'text-emerald-600 dark:text-emerald-400';
  if (!connected) { verdict = 'Offline'; verdictColor = 'text-red-600 dark:text-red-400'; }
  else if (health.status === 'error') { verdict = 'Degraded'; verdictColor = 'text-amber-600 dark:text-amber-400'; }
  else if (health.status === 'loading') { verdict = 'Checking…'; verdictColor = 'text-gray-400'; }

  return (
    <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-3 flex-shrink-0 bg-white dark:bg-gray-950">
        <div className="flex items-center gap-3">
          <Activity className="h-4 w-4 text-blue-500" aria-hidden="true" />
          <div>
            <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Fleet health</h1>
            <p className={`text-xs font-medium ${verdictColor}`}>{verdict}</p>
          </div>
        </div>
        <button onClick={() => void load(true)} className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500" title="Refresh" aria-label="Refresh">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-custom space-y-4">
        {/* Health cells */}
        <div className="flex flex-wrap gap-3">
          <HealthCell {...connCell} />

          {health.status === 'loading' ? (
            <HealthCellSkeleton label="Daemon" />
          ) : health.status === 'error' ? (
            <HealthCell label="Daemon" dot="bad" value="Unreachable" sub="health check failed" />
          ) : (
            <HealthCell label="Daemon" dot="ok" value="Healthy" sub={`up ${fmtUptime(health.data.uptimeSec)}`} />
          )}

          {version.status === 'loading' ? (
            <HealthCellSkeleton label="UI build" />
          ) : version.status === 'error' || !version.data.version ? (
            <HealthCell label="UI build" dot="warn" value="Unknown" sub="version unavailable" />
          ) : (
            <HealthCell
              label="UI build"
              dot="info"
              value={version.data.version.length > 14 ? `${version.data.version.slice(0, 14)}…` : version.data.version}
              sub="auto-reloads on change"
            />
          )}

          <HealthCell
            label="Fleet"
            dot={needsInput > 0 ? 'warn' : active > 0 ? 'ok' : ''}
            value={`${active} active`}
            sub={`${needsInput} need input · ${agents.length} total`}
          />
        </div>

        {/* Raw health data */}
        {health.status === 'ok' && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-widest text-gray-400">
              Daemon details
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800 text-xs">
              {Object.entries(health.data).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between px-4 py-2">
                  <span className="text-gray-500 dark:text-gray-400 font-mono">{key}</span>
                  <span className="text-gray-900 dark:text-gray-100 font-medium">{JSON.stringify(val)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
};
