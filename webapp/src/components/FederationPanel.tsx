/**
 * Federation / leases panel — mirrors the legacy UI's Coordination + Files-in-flight sections.
 *
 * Fetches GET /api/federation and GET /api/leases. Handles the empty/single-operator case
 * gracefully (the DB-mode federation endpoint returns no coordinator when not configured).
 */

import React, { useEffect, useState } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';

interface FedOperator {
  operator?: {
    id?: string;
    displayName?: string;
    origin?: string;
  };
  host?: string;
  availability?: string;
  agents?: Array<{ id: string; name: string; status: string; repo?: string; branch?: string }>;
}

interface FedCollision {
  repo?: string;
  ref?: string;
  operators?: string[];
}

interface FederationResponse {
  coordinator?: string;
  operators?: FedOperator[];
  collisions?: FedCollision[];
}

interface Lease {
  file: string;
  operator?: string;
  session?: string;
  [key: string]: unknown;
}

type LoadState<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error' };

function shortBase(p?: string): string {
  const parts = String(p ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p ?? '');
}

export const FederationPanel: React.FC = () => {
  const { currentProject } = useTaskContext();
  const [fed, setFed] = useState<LoadState<FederationResponse>>({ status: 'idle' });
  const [leases, setLeases] = useState<LoadState<Lease[]>>({ status: 'idle' });

  const load = async () => {
    setFed({ status: 'loading' });
    setLeases({ status: 'loading' });

    const [fedResult, leasesResult] = await Promise.all([
      apiJson<FederationResponse>('/api/federation')
        .then((d): LoadState<FederationResponse> => ({ status: 'ok', data: d }))
        .catch((): LoadState<FederationResponse> => ({ status: 'error' })),
      currentProject?.id
        ? apiJson<Lease[]>(`/api/leases?repo=${encodeURIComponent(currentProject.id)}`)
            .then((d): LoadState<Lease[]> => ({ status: 'ok', data: d }))
            .catch((): LoadState<Lease[]> => ({ status: 'error' }))
        : Promise.resolve<LoadState<Lease[]>>({ status: 'ok', data: [] }),
    ]);

    setFed(fedResult);
    setLeases(leasesResult);
  };

  useEffect(() => { void load(); }, [currentProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group leases by file
  const leasesData = leases.status === 'ok' ? leases.data : [];
  const byFile = new Map<string, Lease[]>();
  for (const l of leasesData) {
    const key = l.file;
    const existing = byFile.get(key);
    if (existing) existing.push(l);
    else byFile.set(key, [l]);
  }

  const fedData = fed.status === 'ok' ? fed.data : null;
  const peers = (fedData?.operators ?? []).filter((o) => o.operator?.origin === 'remote');
  const collisions = fedData?.collisions ?? [];

  let fedStatus = 'checking…';
  let fedStatusColor = 'text-gray-400';
  if (fed.status === 'error') { fedStatus = 'unavailable'; fedStatusColor = 'text-red-500 dark:text-red-400'; }
  else if (fed.status === 'ok') {
    if (!fedData?.coordinator) { fedStatus = 'single-operator'; fedStatusColor = 'text-gray-600 dark:text-gray-300'; }
    else if (peers.length) { fedStatus = 'connected'; fedStatusColor = 'text-emerald-600 dark:text-emerald-400'; }
    else { fedStatus = 'no peers online'; fedStatusColor = 'text-gray-500'; }
  }

  return (
    <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-3 flex-shrink-0 bg-white dark:bg-gray-950">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-indigo-500" aria-hidden="true" />
          <div>
            <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Coordination</h1>
            <p className={`mt-0.5 text-xs font-medium ${fedStatusColor}`}>{fedStatus}</p>
          </div>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500" title="Refresh" aria-label="Refresh">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-custom space-y-4">
        {/* Federation */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-widest text-gray-400">Federation</div>
          <div className="p-4">
            {fed.status === 'loading' && (
              <div className="space-y-2 animate-pulse">
                {[1, 2].map((n) => <div key={n} className="h-5 rounded bg-gray-100 dark:bg-gray-800" />)}
              </div>
            )}
            {fed.status === 'error' && (
              <p className="text-sm text-red-600 dark:text-red-400">Coordination status unavailable right now.</p>
            )}
            {fed.status === 'ok' && !fedData?.coordinator && (
              <div className="flex items-start gap-3">
                <span className="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-gray-300 dark:bg-gray-600" aria-hidden="true" />
                <div>
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Single-operator</div>
                  <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">No federation coordinator configured — agents, presence, and file leases stay on this host.</div>
                </div>
              </div>
            )}
            {fed.status === 'ok' && fedData?.coordinator && (
              <div className="space-y-2">
                {peers.length === 0 && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Coordinator connected — no peer operators online right now.</p>
                )}
                {peers.map((op, i) => {
                  const who = op.operator?.displayName ?? op.operator?.id ?? 'unknown';
                  const avDot = op.availability === 'active' ? 'bg-emerald-500' : op.availability === 'away' ? 'bg-amber-400' : 'bg-gray-300';
                  return (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${avDot}`} aria-hidden="true" />
                        <span className="font-medium text-gray-900 dark:text-gray-100">{who}</span>
                        {op.host && <span className="text-gray-500 dark:text-gray-400">@{op.host}</span>}
                        <span className="text-gray-400 text-xs">· {(op.agents ?? []).length} agent{(op.agents ?? []).length === 1 ? '' : 's'}</span>
                      </div>
                      {(op.agents ?? []).map((a) => (
                        <div key={a.id} className="ml-6 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                          <span className={`text-[10px] font-semibold rounded px-1 py-0.5 border ${a.status === 'working' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400' : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400'}`}>{a.status}</span>
                          {a.name} <span className="text-gray-400">{shortBase(a.repo)}{a.branch ? ` · ${a.branch}` : ''}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {collisions.length > 0 && (
                  <div className="mt-3 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 p-3">
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <span aria-hidden="true">⚠</span> Shared-branch collisions
                    </div>
                    {collisions.map((c, i) => (
                      <div key={i} className="text-xs text-gray-700 dark:text-gray-300">
                        {shortBase(c.repo)} <span className="text-gray-400">@ {c.ref} — {(c.operators ?? []).join(', ')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Files in flight (leases) */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-widest text-gray-400">
            Files in flight{currentProject?.name ? ` · ${currentProject.name}` : ''}
          </div>
          <div className="p-4">
            {leases.status === 'loading' && (
              <div className="space-y-2 animate-pulse">
                {[1, 2].map((n) => <div key={n} className="h-5 rounded bg-gray-100 dark:bg-gray-800" />)}
              </div>
            )}
            {leases.status === 'error' && (
              <p className="text-sm text-gray-500 dark:text-gray-400">—</p>
            )}
            {leases.status === 'ok' && byFile.size === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">No files claimed.</p>
            )}
            {leases.status === 'ok' && byFile.size > 0 && (
              <div className="space-y-1">
                {[...byFile.entries()].map(([file, holders]) => {
                  const holderIds = [...new Set(holders.map((h) => `${h.operator ?? '?'}/${h.session ?? '?'}`))];
                  const conflict = holderIds.length > 1;
                  return (
                    <div key={file} className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${conflict ? 'bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300' : 'text-gray-700 dark:text-gray-300'}`}>
                      {conflict && <span aria-hidden="true" className="text-amber-500">⚠</span>}
                      <span className="font-mono truncate flex-1">{file}</span>
                      <span className="text-gray-400 flex-shrink-0">— {holderIds.join(', ')}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
};
