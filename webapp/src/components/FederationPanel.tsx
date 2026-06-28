/**
 * FederationPanel — "Coordination" panel.
 *
 * LEAD WITH WHAT'S HAPPENING RIGHT NOW, not with what's absent.
 *
 * Single-operator (no coordinator):
 *   Primary content = "In flight · this host": files currently being edited
 *   by live/working agents, derived from /api/usage runs + /api/leases.
 *   A warn Callout surfaces any file-level collision (≥2 agents) — useful
 *   even without federation. Federation gets a small, muted footer nudge.
 *
 * Federated (coordinator present):
 *   Primary content = peer operators with host, availability, agent count.
 *   Cross-host collisions surface as a critical/warn Callout — the real value
 *   of federation. In-flight files follow below as supporting context.
 *
 * Data sources:
 *   GET /api/federation  → { coordinator, operators, collisions? }
 *   GET /api/leases      → Lease[]
 *   GET /api/usage?limit=200 → { runs: UsageRun[] }
 *   agents               → from TaskContext (live WS roster)
 *
 * Poll: 10 s. Pattern matches AttentionPanel exactly.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Network, RefreshCw, ExternalLink } from 'lucide-react';
import { apiJson } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import { detectCollisions, type UsagePayload, type UsageRun } from '../lib/insights';
import { PanelShell, VerdictBadge, Callout, SectionCard, relativeAge } from './ui';

// ── API shapes ────────────────────────────────────────────────────────────────

interface FedAgent {
  id: string;
  name: string;
  status: string;
  repo?: string;
  branch?: string;
}

interface FedOperator {
  operator?: {
    id?: string;
    displayName?: string;
    origin?: string;
  };
  host?: string;
  availability?: string;
  agents?: FedAgent[];
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
  agentId?: string;
  agentName?: string;
  operator?: string;
  session?: string;
  claimedAt?: number;
  [key: string]: unknown;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

function shortBase(p?: string): string {
  const parts = String(p ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p ?? '');
}

/** Derive "files in flight" from usage runs (status=working) + leases.
 * Returns a map: file → { agentIds, agentNames, since } */
function filesInFlight(
  runs: UsageRun[],
  leases: Lease[],
): Map<string, { agentIds: Set<string>; agentNames: string[]; since?: number }> {
  const byFile = new Map<string, { agentIds: Set<string>; agentNames: string[]; since?: number }>();

  const upsert = (file: string, agentId: string, agentName: string, since?: number) => {
    let entry = byFile.get(file);
    if (!entry) {
      entry = { agentIds: new Set(), agentNames: [], since };
      byFile.set(file, entry);
    }
    if (!entry.agentIds.has(agentId)) {
      entry.agentIds.add(agentId);
      entry.agentNames.push(agentName);
    }
    if (since && (!entry.since || since > entry.since)) entry.since = since;
  };

  // Working runs with touched files
  for (const run of runs) {
    if (run.status !== 'working') continue;
    for (const file of run.filesTouched ?? []) {
      if (file) upsert(file, run.agentId, run.name, run.startedAt);
    }
  }

  // Active leases (complements runs; may have files not yet in usage)
  for (const lease of leases) {
    if (lease.file && lease.agentId) {
      upsert(lease.file, lease.agentId, lease.agentName ?? lease.agentId, lease.claimedAt);
    }
  }

  return byFile;
}

// ── component ─────────────────────────────────────────────────────────────────

export const FederationPanel: React.FC = () => {
  const { agents, currentProject, subscribeConsole, setIsChatOpen } = useTaskContext();

  const [fed, setFed] = useState<FederationResponse | null>(null);
  const [leases, setLeases] = useState<Lease[]>([]);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [fedData, leasesData, usageData] = await Promise.all([
        apiJson<FederationResponse>('/api/federation').catch(() => null),
        currentProject?.id
          ? apiJson<Lease[]>(`/api/leases?repo=${encodeURIComponent(currentProject.id)}`).catch(() => [])
          : Promise.resolve<Lease[]>([]),
        apiJson<UsagePayload>('/api/usage?limit=200').catch(() => null),
      ]);
      setFed(fedData);
      setLeases(leasesData ?? []);
      setUsage(usageData);
      setError('');
    } catch {
      setError('Could not reach the daemon for coordination status.');
    } finally {
      setLoaded(true);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 10_000);
    return () => clearInterval(interval);
  }, [load]);

  const openConsole = useCallback(
    (agentId?: string) => {
      if (agentId) subscribeConsole(agentId);
      setIsChatOpen(true);
    },
    [subscribeConsole, setIsChatOpen],
  );

  // ── derived state ──────────────────────────────────────────────────────────

  const hasCoordinator = Boolean(fed?.coordinator);
  const peers = useMemo(
    () => (fed?.operators ?? []).filter((o) => o.operator?.origin === 'remote'),
    [fed],
  );
  const fedCollisions = fed?.collisions ?? [];

  // Local collision detection (same-host, ≥2 live agents on one file)
  const localCollisions = useMemo(
    () => detectCollisions(usage?.runs, agents),
    [usage?.runs, agents],
  );

  // In-flight file map
  const inFlight = useMemo(
    () => filesInFlight(usage?.runs ?? [], leases),
    [usage, leases],
  );

  // ── subtitle / verdict ────────────────────────────────────────────────────

  const verdictText = (() => {
    if (!hasCoordinator) return 'single-operator';
    if (peers.length === 0) return 'federated · no peers';
    return `${peers.length} peer${peers.length === 1 ? '' : 's'}`;
  })();

  const verdictKind: 'healthy' | 'warn' | 'critical' =
    fedCollisions.length > 0 || localCollisions.length > 0 ? 'warn' : 'healthy';

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={verdictKind}>{verdictText}</VerdictBadge>
      {(fedCollisions.length > 0 || localCollisions.length > 0) && (
        <>
          <span className="text-gray-400">·</span>
          <span className="text-amber-600 dark:text-amber-400 font-medium">
            {fedCollisions.length + localCollisions.length} collision{fedCollisions.length + localCollisions.length === 1 ? '' : 's'}
          </span>
        </>
      )}
    </span>
  );

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <PanelShell
      icon={<Network className="h-4 w-4 text-indigo-500" aria-hidden="true" />}
      title="Coordination"
      subtitle={loaded ? subtitle : undefined}
      actions={refresh}
    >
      {/* Loading skeleton */}
      {!loaded && !error && (
        <div className="space-y-2 animate-pulse" aria-label="Loading coordination status">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-14 rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {/* Error state */}
      {loaded && error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loaded && !error && (
        <>
          {/* ── FEDERATED MODE: lead with peers ─────────────────────────── */}
          {hasCoordinator && (
            <>
              {/* Cross-host collision callout — the high-value federated signal */}
              {fedCollisions.length > 0 && (
                <Callout
                  tone="warn"
                  title={`${fedCollisions.length} cross-host collision${fedCollisions.length === 1 ? '' : 's'} — same repo touched by multiple operators`}
                >
                  {fedCollisions.map((c, i) => (
                    <div key={i} className="mt-1 font-mono text-[11px] text-gray-700 dark:text-gray-300">
                      {shortBase(c.repo)}
                      {c.ref ? <span className="text-gray-400"> @ {c.ref}</span> : null}
                      {(c.operators ?? []).length > 0 && (
                        <span className="text-gray-500"> — {c.operators!.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </Callout>
              )}

              {/* Peer operators */}
              <SectionCard
                title="Peer operators"
                right={peers.length > 0 ? `${peers.length} online` : undefined}
              >
                {peers.length === 0 ? (
                  <div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
                    Coordinator connected — no peer operators online right now.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100 dark:divide-gray-800">
                    {peers.map((op, i) => {
                      const who = op.operator?.displayName ?? op.operator?.id ?? 'unknown';
                      const avColor =
                        op.availability === 'active'
                          ? 'bg-emerald-500'
                          : op.availability === 'away'
                            ? 'bg-amber-400'
                            : 'bg-gray-300 dark:bg-gray-600';
                      const agentList = op.agents ?? [];
                      return (
                        <div key={i} className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className={`h-2 w-2 flex-shrink-0 rounded-full ${avColor}`}
                              aria-label={op.availability ?? 'unknown'}
                            />
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {who}
                            </span>
                            {op.host && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                @{op.host}
                              </span>
                            )}
                            <span className="ml-auto text-xs text-gray-400">
                              {agentList.length} agent{agentList.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          {agentList.length > 0 && (
                            <div className="mt-1.5 space-y-1 pl-4">
                              {agentList.map((a) => (
                                <div
                                  key={a.id}
                                  className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400"
                                >
                                  <span
                                    className={`rounded px-1 py-0.5 text-[10px] font-semibold border ${
                                      a.status === 'working'
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
                                        : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400'
                                    }`}
                                  >
                                    {a.status}
                                  </span>
                                  <span>{a.name}</span>
                                  {a.repo && (
                                    <span className="text-gray-400">
                                      {shortBase(a.repo)}
                                      {a.branch ? ` · ${a.branch}` : ''}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>
            </>
          )}

          {/* ── LOCAL COLLISION WARNING (useful in both modes) ────────── */}
          {localCollisions.length > 0 && (
            <Callout
              tone="warn"
              title={`${localCollisions.length} file${localCollisions.length === 1 ? '' : 's'} touched by multiple agents — merge collision risk`}
            >
              {localCollisions.map((c) => (
                <div key={c.file} className="mt-1 flex items-center gap-2">
                  <span className="font-mono text-[11px] text-gray-700 dark:text-gray-300">
                    {shortPath(c.file)}
                  </span>
                  <span className="text-gray-400 text-[11px]">
                    — {c.agents.map((a) => a.name).join(', ')}
                  </span>
                  <button
                    onClick={() => openConsole(c.agents[0]?.id)}
                    className="ml-auto text-[11px] text-blue-600 dark:text-blue-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    aria-label={`View agent for ${c.file}`}
                  >
                    view
                  </button>
                </div>
              ))}
            </Callout>
          )}

          {/* ── IN FLIGHT · THIS HOST ─────────────────────────────────── */}
          <SectionCard
            title="In flight · this host"
            right={inFlight.size > 0 ? `${inFlight.size}` : undefined}
          >
            {inFlight.size === 0 ? (
              <div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
                No files being edited right now.
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {[...inFlight.entries()].map(([file, info]) => {
                  const isConflict = info.agentIds.size >= 2;
                  const firstAgentId = [...info.agentIds][0];
                  return (
                    <div
                      key={file}
                      className={`flex items-center gap-2 px-4 py-2.5 ${
                        isConflict ? 'bg-amber-50/60 dark:bg-amber-950/10' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1 font-mono text-xs text-gray-800 dark:text-gray-200 truncate">
                        {shortPath(file)}
                      </span>
                      <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400 truncate max-w-[120px]">
                        {info.agentNames.join(', ')}
                      </span>
                      {info.since && (
                        <span
                          className="flex-shrink-0 text-[11px] text-gray-400 tabular-nums"
                          title={new Date(info.since).toLocaleTimeString()}
                        >
                          {relativeAge(info.since)}
                        </span>
                      )}
                      <button
                        onClick={() => openConsole(firstAgentId)}
                        className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                        title="View agent"
                        aria-label={`View agent for ${file}`}
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          {/* ── FEDERATION FOOTER (single-operator only) ─────────────── */}
          {!hasCoordinator && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 px-1">
              Federation: off — set{' '}
              <code className="font-mono text-gray-500 dark:text-gray-400">OMP_SQUAD_COORDINATOR</code>{' '}
              to see other operators &amp; cross-host collisions.
            </p>
          )}
        </>
      )}
    </PanelShell>
  );
};
