/**
 * AutomationPanel — "Is autonomy earning its keep?"
 *
 * Answers the operator's core question at a glance:
 *   - Did the loops produce anything this window, or burn tokens for nothing?
 *   - Are there anomalies that need investigation (Dispatch found N, spawned 0)?
 *   - What did each loop actually *do* (outcomes: filed, spawned, closed)?
 *   - How much did it cost, and is the Scout LLM budget healthy?
 *
 * Structure (top → bottom):
 *   1. PanelShell header: VerdictBadge + spend/output one-liner
 *   2. Anomaly Callouts (HEADLINE) — the buried red flags made visible
 *   3. Outcome summary — 4 loop cards, outcome-first
 *   4. Spend & budget strip
 *   5. Event log (collapsed by default — firehose stays out of the way)
 *
 * Data: polls GET /api/automation + GET /api/usage every 10s.
 * WS: the `automation` event type is not yet in SquadEvent; polling is the live path.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Zap, CheckCircle2 } from 'lucide-react';
import { apiJson } from '../lib/api';
import {
  automationDigest,
  type AutomationRollup,
  type UsagePayload,
} from '../lib/insights';
import {
  PanelShell,
  VerdictBadge,
  StatTile,
  Callout,
  SectionCard,
  relativeAge,
} from './ui';

// ─── local types ─────────────────────────────────────────────────────────────

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

interface AutomationResponse {
  events: AutomationEvent[];
  rollup: AutomationRollup[];
}

// ─── constants ───────────────────────────────────────────────────────────────

const AUTO_WINDOWS: Array<[string, number]> = [
  ['15m', 900_000],
  ['1h', 3_600_000],
  ['6h', 21_600_000],
  ['24h', 86_400_000],
];

const WINDOW_LABEL: Record<number, string> = {
  900_000: '15m',
  3_600_000: '1h',
  21_600_000: '6h',
  86_400_000: '24h',
};

const LOOP_META: Record<string, { label: string; desc: string; usesLlm: boolean }> = {
  scout:       { label: 'Scout',       desc: 'reads agent reasoning → backlog', usesLlm: true },
  observer:    { label: 'Observer',    desc: 'audits fleet & gate health',       usesLlm: false },
  opportunity: { label: 'Opportunity', desc: 'clusters scout patterns',          usesLlm: false },
  dispatch:    { label: 'Dispatch',    desc: 'spawns agents from Plane',         usesLlm: false },
};

const LOOP_ORDER = ['scout', 'observer', 'opportunity', 'dispatch'];

// ─── helpers ─────────────────────────────────────────────────────────────────

function shortRepo(p?: string): string {
  const parts = String(p ?? '').split('/');
  return parts[parts.length - 1] || (p ?? '');
}

function fmt(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

// ─── component ───────────────────────────────────────────────────────────────

export const AutomationPanel: React.FC = () => {
  const [data, setData] = useState<AutomationResponse>({ events: [], rollup: [] });
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [loopFilter, setLoopFilter] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '200', windowMs: String(windowMs) });
    if (loopFilter) params.set('loop', loopFilter);
    try {
      const [result, u] = await Promise.all([
        apiJson<AutomationResponse>(`/api/automation?${params.toString()}`),
        apiJson<UsagePayload>('/api/usage').catch(() => null),
      ]);
      setData(result);
      setUsage(u);
      setError('');
    } catch {
      setError('Could not reach the daemon for automation activity.');
    } finally {
      setLoaded(true);
    }
  }, [windowMs, loopFilter]);

  useEffect(() => {
    setLoaded(false);
    void load();
    const interval = setInterval(() => void load(), 10_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // ── digest ────────────────────────────────────────────────────────────────

  const digest = automationDigest(data.rollup, usage);
  const windowLabel = WINDOW_LABEL[windowMs] ?? '1h';

  // Outcome verdict: healthy if loops produced anything; warn if they ran but
  // produced nothing; neutral/idle when no activity at all this window.
  const hasActivity = data.rollup.some((r) => r.events > 0);
  const hasOutput = digest.ticketsFiled > 0 || digest.agentsSpawned > 0;
  const hasAnomalies = digest.anomalies.length > 0;

  let verdictKind: 'healthy' | 'warn' | 'critical' | 'ok';
  let verdictText: string;
  if (!loaded) {
    verdictKind = 'ok';
    verdictText = 'Loading…';
  } else if (error) {
    verdictKind = 'critical';
    verdictText = 'Offline';
  } else if (hasAnomalies) {
    verdictKind = 'warn';
    verdictText = `${digest.anomalies.length} anomal${digest.anomalies.length === 1 ? 'y' : 'ies'}`;
  } else if (!hasActivity) {
    verdictKind = 'ok';
    verdictText = 'Idle';
  } else if (hasOutput) {
    verdictKind = 'healthy';
    verdictText = 'Producing';
  } else {
    verdictKind = 'ok';
    verdictText = 'Active';
  }

  const spendLine = `${fmtUsd(digest.spentUsd)} · ${digest.llmCalls} LLM call${digest.llmCalls === 1 ? '' : 's'} · last ${windowLabel} — ${digest.ticketsFiled} filed · ${digest.agentsSpawned} spawned`;

  // ── header controls ───────────────────────────────────────────────────────

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={verdictKind}>{verdictText}</VerdictBadge>
      <span className="text-gray-400">·</span>
      <span>{spendLine}</span>
    </span>
  );

  const actions = (
    <>
      <select
        value={windowMs}
        onChange={(e) => setWindowMs(Number(e.target.value) || 3_600_000)}
        className="text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        aria-label="Rollup window"
      >
        {AUTO_WINDOWS.map(([lbl, ms]) => (
          <option key={ms} value={ms}>{lbl}</option>
        ))}
      </select>
      <select
        value={loopFilter}
        onChange={(e) => setLoopFilter(e.target.value)}
        className="text-xs rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        aria-label="Filter by loop"
      >
        <option value="">all loops</option>
        {Object.entries(LOOP_META).map(([key, val]) => (
          <option key={key} value={key}>{val.label}</option>
        ))}
      </select>
      <button
        onClick={() => void load()}
        className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        title="Refresh"
        aria-label="Refresh"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
      </button>
    </>
  );

  return (
    <PanelShell
      icon={<Zap className="h-4 w-4 text-amber-500" />}
      title="Autonomy"
      subtitle={subtitle}
      actions={actions}
    >
      {/* ── Loading skeleton ─────────────────────────────────────────── */}
      {!loaded && !error && (
        <div className="space-y-3 animate-pulse">
          <div className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800" />
          <div className="flex gap-3">
            {[1, 2, 3, 4].map((n) => <div key={n} className="h-24 flex-1 rounded-lg bg-gray-100 dark:bg-gray-800" />)}
          </div>
        </div>
      )}

      {/* ── Error state ──────────────────────────────────────────────── */}
      {loaded && error && (
        <Callout tone="critical" title="Daemon unreachable">
          {error}
        </Callout>
      )}

      {loaded && !error && (
        <>
          {/* ── 1. ANOMALY CALLOUTS — headline, not noise ─────────────── */}
          {digest.anomalies.length > 0 && (
            <div className="space-y-2" role="region" aria-label="Anomalies">
              {digest.anomalies.map((a, i) => (
                <Callout
                  key={i}
                  tone="warn"
                  title={a.message}
                  action={
                    a.loop === 'dispatch' || a.loop === 'opportunity'
                      ? { label: 'Inspect loop', onClick: () => setLoopFilter(a.loop) }
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {/* ── Calm idle state ───────────────────────────────────────── */}
          {!hasActivity && digest.anomalies.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 px-6 py-10 text-center">
              <CheckCircle2 className="h-8 w-8 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              <div className="text-base font-semibold text-gray-600 dark:text-gray-300">
                Loops idle — {fmtUsd(digest.spentUsd)} spent, nothing to act on
              </div>
              <div className="text-sm text-gray-400 dark:text-gray-500">
                No background activity in the last {windowLabel}. Loops run once agents and Plane repos are configured.
              </div>
            </div>
          )}

          {/* ── 2. OUTCOME SUMMARY — 4 loop cards, outcome-first ─────── */}
          {hasActivity && (
            <SectionCard title="What the loops did this window">
              <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-4">
                {LOOP_ORDER.map((loop) => {
                  const meta = LOOP_META[loop];
                  if (!meta) return null;
                  const r = data.rollup.find((row) => row.loop === loop);
                  const filed = r?.filed ?? 0;
                  const spawned = r?.spawned ?? 0;
                  const found = r?.found ?? 0;
                  const events = r?.events ?? 0;
                  const llmCalls = r?.llmCalls ?? 0;
                  const errors = r?.errors ?? 0;
                  const lastAt = r?.lastAt;
                  const produced = filed > 0 || spawned > 0;
                  const hasErr = errors > 0;

                  return (
                    <div
                      key={loop}
                      className={`flex flex-col gap-2 rounded-lg border p-3 ${
                        hasErr
                          ? 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/20'
                          : produced
                          ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20'
                          : events > 0
                          ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
                          : 'border-dashed border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40'
                      }`}
                    >
                      {/* Loop header */}
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">{meta.label}</span>
                        {meta.usesLlm && llmCalls > 0 && (
                          <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                            {llmCalls} LLM
                          </span>
                        )}
                        {meta.usesLlm && llmCalls === 0 && events > 0 && (
                          <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                            0 LLM
                          </span>
                        )}
                        {hasErr && (
                          <span className="rounded-full bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                            {errors} err
                          </span>
                        )}
                      </div>

                      {/* Outcome row — the headline metric */}
                      {events === 0 ? (
                        <div className="text-[11px] text-gray-400 italic">no activity this window</div>
                      ) : (
                        <div className="space-y-0.5">
                          {/* Primary outcome */}
                          {loop === 'dispatch' && (
                            <div className={`text-sm font-semibold ${spawned > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'}`}>
                              {spawned > 0 ? `${spawned} spawned` : 'produced nothing'}
                            </div>
                          )}
                          {loop !== 'dispatch' && (
                            <div className={`text-sm font-semibold ${filed > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'}`}>
                              {filed > 0 ? `${filed} filed` : 'produced nothing'}
                            </div>
                          )}
                          {/* Supporting data */}
                          <div className="flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                            {found > 0 && <span>{found} found</span>}
                            <span>{events} ticks</span>
                          </div>
                        </div>
                      )}

                      {/* Last seen */}
                      {lastAt != null && lastAt > 0 && (
                        <div className="mt-auto text-[10px] text-gray-400">
                          {relativeAge(lastAt)} ago
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {/* ── 3. SPEND & BUDGET ─────────────────────────────────────── */}
          {hasActivity && (
            <div className="flex flex-wrap gap-3">
              <StatTile
                label="Spend today"
                value={fmtUsd(digest.spentUsd)}
                sub="all loops, from /api/usage"
                tone={digest.spentUsd > 1 ? 'warn' : 'neutral'}
              />
              <StatTile
                label="Scout LLM budget"
                value={`${digest.scoutBudget.used} / ${digest.scoutBudget.cap}`}
                sub={
                  digest.scoutBudget.used >= digest.scoutBudget.cap
                    ? 'budget exhausted this window'
                    : `${digest.scoutBudget.cap - digest.scoutBudget.used} calls remaining`
                }
                tone={
                  digest.scoutBudget.used >= digest.scoutBudget.cap
                    ? 'warn'
                    : digest.scoutBudget.used >= digest.scoutBudget.cap * 0.8
                    ? 'warn'
                    : 'neutral'
                }
              />
              <StatTile
                label="Total LLM calls"
                value={digest.llmCalls}
                sub={`${windowLabel} window · Scout only`}
                tone="info"
              />
            </div>
          )}

          {/* ── 4. EVENT LOG — collapsed by default ──────────────────── */}
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 select-none transition-colors">
              <span className="mr-auto">Show event log</span>
              <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                {data.events.length}
              </span>
              <span className="text-gray-300 dark:text-gray-600 group-open:rotate-180 transition-transform" aria-hidden="true">▾</span>
            </summary>

            <div className="mt-1 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
              {data.events.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">
                  No events in this window.
                </div>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-gray-800 px-4 py-2">
                  {data.events.map((e, i) => {
                    const meta = LOOP_META[e.loop];
                    const who = e.agent ? e.agent : e.repo ? shortRepo(e.repo) : 'fleet';
                    const dur = typeof e.durationMs === 'number' ? fmt(e.durationMs) : undefined;
                    return (
                      <div
                        key={i}
                        className="grid grid-cols-[auto_1fr_auto_auto] items-start gap-x-3 gap-y-0.5 py-1.5 text-xs last:border-b-0"
                      >
                        <span
                          className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:text-gray-300"
                          title={meta?.label ?? e.loop}
                        >
                          {e.loop}
                        </span>
                        <span className="truncate text-gray-700 dark:text-gray-300 font-medium">{who}</span>
                        <div className="flex flex-wrap gap-1">
                          {e.llmCalls != null && e.llmCalls > 0 && (
                            <span className="rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                              {e.llmCalls} LLM
                            </span>
                          )}
                          {e.found != null && e.found > 0 && (
                            <span className="rounded bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:text-blue-300">
                              {e.found} found
                            </span>
                          )}
                          {e.filed != null && e.filed > 0 && (
                            <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                              {e.filed} filed
                            </span>
                          )}
                          {e.spawned != null && e.spawned > 0 && (
                            <span className="rounded bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                              {e.spawned} spawned
                            </span>
                          )}
                          {e.level === 'error' && (
                            <span className="rounded bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">error</span>
                          )}
                          {e.level === 'warn' && (
                            <span className="rounded bg-amber-100 dark:bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">warn</span>
                          )}
                          {!e.llmCalls && !e.found && !e.filed && !e.spawned && e.level !== 'error' && e.level !== 'warn' && (
                            <span className="text-gray-400">—</span>
                          )}
                        </div>
                        <span className="text-gray-400 whitespace-nowrap text-[10px]">
                          {dur ? `${dur} · ` : ''}{relativeAge(e.at)} ago
                        </span>
                        {e.detail && (
                          <span className="col-span-4 whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400 pl-2 text-[11px]">
                            {e.detail}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </details>
        </>
      )}
    </PanelShell>
  );
};
