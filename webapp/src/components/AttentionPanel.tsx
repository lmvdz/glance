/**
 * AttentionPanel — the "Needs you" reference panel and the gold standard the
 * other four panels match.
 *
 * It LEADS WITH A VERDICT: a calm "all clear" when nothing needs you, a loud,
 * sorted, one-click-actionable list when something does. Every row carries the
 * single action that resolves it, wired end-to-end:
 *   • Answer  → inline composer → answerCommand over the live WS
 *   • Land    → POST /api/agents/{id}/land
 *   • Restart → restartCommand over the live WS
 *   • View    → open the agent's console
 *   • Raise cap → guidance toast (cap is an env var; surfaced, not silently set)
 *
 * Roster comes from the live WS (TaskContext.agents) so blocked/errored/land
 * states are instant; governance / usage / action-items are polled every 10s for
 * capacity, collisions, and the health warnings the client can't derive.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Inbox, RefreshCw, Send, X, CheckCircle2, ArrowUpDown, Bell, BellOff } from 'lucide-react';
import { apiJson, jsonInit } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import { answerCommand, restartCommand, steerCommand } from '../lib/agent-control';
import { enablePush, pushPermission } from '../lib/push';
import {
  attentionItems,
  detectCollisions,
  computeCapacity,
  type AttentionItem,
  type GovernancePayload,
  type UsagePayload,
  type ServerActionItem,
} from '../lib/insights';
import { PanelShell, VerdictBadge, SectionCard, AttentionRow, StatTile } from './ui';

interface ActionItemsResponse {
  items: ServerActionItem[];
  generatedAt: number;
}

const SEVERITY_GROUPS: { key: 'critical' | 'warn'; title: string }[] = [
  { key: 'critical', title: 'Critical — blocking work' },
  { key: 'warn', title: 'Worth a look' },
];

export const AttentionPanel: React.FC = () => {
  const { agents, connected, openConsole, sendConsoleCommand, showToast } = useTaskContext();

  const [gov, setGov] = useState<GovernancePayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [serverItems, setServerItems] = useState<ServerActionItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [answering, setAnswering] = useState<AttentionItem | null>(null);
  const [answerText, setAnswerText] = useState('');
  const answerRef = useRef<HTMLTextAreaElement | null>(null);
  // Ranking toggle (cmux-style rankable notification panel): default stays the
  // severity-led order; "blocked-longest" re-ranks the whole list by age so the
  // operator can see who's been waiting longest.
  const [sort, setSort] = useState<'severity' | 'blocked-longest'>('severity');
  // Background push enrollment. This panel is the always-visible attention surface
  // (unlike AccountMenu, which is null in file mode — where the autonomous factory
  // runs), so the file-mode operator can enable phone/desktop push from here.
  const [pushPerm, setPushPerm] = useState<NotificationPermission | 'unsupported'>(() => pushPermission());
  const enablePushHere = useCallback(async () => {
    if (pushPerm === 'granted') return;
    const result = await enablePush();
    setPushPerm(pushPermission());
    if (result === 'granted') showToast('Background push enabled — a blocked unit will now buzz this device', 'success');
    else if (result === 'denied') showToast('Notification permission denied', 'error');
  }, [pushPerm, showToast]);

  const load = useCallback(async () => {
    try {
      const [g, u, ai] = await Promise.all([
        apiJson<GovernancePayload>('/api/governance').catch(() => null),
        apiJson<UsagePayload>('/api/usage?limit=200').catch(() => null),
        apiJson<ActionItemsResponse>('/api/action-items').catch(() => ({ items: [], generatedAt: 0 })),
      ]);
      setGov(g);
      setUsage(u);
      setServerItems(ai.items ?? []);
      setError('');
    } catch {
      setError('Could not reach the daemon for fleet status.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 10_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (answering) answerRef.current?.focus();
  }, [answering]);

  const capacity = useMemo(() => computeCapacity(gov), [gov]);
  const collisions = useMemo(() => detectCollisions(usage?.runs, agents), [usage?.runs, agents]);
  const items = useMemo(
    () => attentionItems({ actionItems: serverItems, agents, capacity, collisions }, { sort }),
    [serverItems, agents, capacity, collisions, sort],
  );

  const critical = items.filter((i) => i.severity === 'critical');
  const warn = items.filter((i) => i.severity === 'warn');
  const grouped: Record<'critical' | 'warn', AttentionItem[]> = { critical, warn };
  // "Longest waiting" is a cmux-style single ranked queue — splitting it back into
  // severity buckets would defeat the point of ranking by age across the whole
  // list, so it renders as one section instead of the two severity groups.
  const sections: { key: string; title: string; rows: AttentionItem[] }[] =
    sort === 'blocked-longest'
      ? items.length > 0
        ? [{ key: 'all', title: 'Longest waiting', rows: items }]
        : []
      : SEVERITY_GROUPS.filter(({ key }) => grouped[key].length > 0).map(({ key, title }) => ({ key, title, rows: grouped[key] }));

  const working = agents.filter((a) => a.status === 'working').length;
  const idle = agents.filter((a) => a.status === 'idle').length;

  // ── actions ──────────────────────────────────────────────────────────────

  const submitAnswer = useCallback(() => {
    if (!answering?.agentId || !answerText.trim()) return;
    const isSteer = answering.action?.kind === 'steer';
    // Steer redirects a live agent with a fresh turn — unlike Answer, it has no pending request to
    // resolve, so `requestId` is only required off the answer path.
    if (!isSteer && !answering.requestId) return;
    if (isSteer) {
      sendConsoleCommand(steerCommand(answering.agentId, answerText.trim()));
      showToast(`Steer sent to ${answering.title.replace(/ has gone quiet.*/, '')}`, 'success');
    } else {
      sendConsoleCommand(answerCommand(answering.agentId, answering.requestId!, answerText.trim()));
      showToast(`Answer sent to ${answering.title.replace(/ is waiting.*/, '')}`, 'success');
    }
    setAnswering(null);
    setAnswerText('');
    void load();
  }, [answering, answerText, sendConsoleCommand, showToast, load]);

  const land = useCallback(
    async (item: AttentionItem) => {
      if (!item.agentId) return;
      setBusyId(item.id);
      type LandResult = { ok: boolean; merged?: boolean; detail?: string; message?: string };
      try {
        const res: LandResult = await apiJson<LandResult>(
          `/api/agents/${encodeURIComponent(item.agentId)}/land`,
          jsonInit('POST', {}),
        ).catch((e: Error): LandResult => ({ ok: false, detail: e.message }));
        if (res.ok) {
          showToast(res.merged ? 'Landed and merged' : 'Landed', 'success');
        } else {
          showToast(res.detail || res.message || 'Land blocked — proof gate not satisfied', 'error');
        }
      } finally {
        setBusyId(null);
        void load();
      }
    },
    [showToast, load],
  );

  const onAction = useCallback(
    (item: AttentionItem) => {
      switch (item.action?.kind) {
        case 'answer':
        case 'steer':
          setAnswering(item);
          setAnswerText('');
          break;
        case 'restart':
          if (item.agentId) {
            sendConsoleCommand(restartCommand(item.agentId));
            showToast('Restart sent', 'success');
          }
          break;
        case 'land':
          void land(item);
          break;
        case 'view':
          openConsole(item.agentId);
          break;
        case 'raise-cap':
          showToast('WIP cap is set by OMP_SQUAD_WIP_CAP — raise it and restart the daemon to allow more concurrent agents.', 'info');
          break;
      }
    },
    [sendConsoleCommand, showToast, land, openConsole],
  );

  // ── verdict ──────────────────────────────────────────────────────────────

  const verdict = critical.length > 0 ? 'critical' : warn.length > 0 ? 'warn' : 'healthy';
  const verdictText =
    critical.length > 0
      ? `${critical.length} need${critical.length === 1 ? 's' : ''} you now`
      : warn.length > 0
        ? `${warn.length} worth a look`
        : 'All clear';

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={verdict}>{verdictText}</VerdictBadge>
      <span className="text-gray-400">·</span>
      <span>{capacity.headline}</span>
      {!connected && <span className="text-red-500 dark:text-red-400">· daemon offline</span>}
    </span>
  );

  const sortToggle = (
    <button
      onClick={() => setSort((s) => (s === 'severity' ? 'blocked-longest' : 'severity'))}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      title={sort === 'severity' ? 'Sorted newest first — click to sort by longest waiting' : 'Sorted by longest waiting — click to sort newest first'}
      aria-label="Toggle attention sort order"
    >
      <ArrowUpDown className="h-3 w-3" aria-hidden="true" />
      {sort === 'severity' ? 'Newest' : 'Longest waiting'}
    </button>
  );

  const refresh = (
    <button
      onClick={() => void load()}
      className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  const pushToggle =
    pushPerm === 'unsupported' ? null : (
      <button
        onClick={() => void enablePushHere()}
        disabled={pushPerm === 'granted'}
        className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-default disabled:opacity-60"
        title={pushPerm === 'granted' ? 'Background push enabled — a blocked unit buzzes this device even when the tab is closed' : 'Enable background push so a blocked unit reaches you when you are not watching'}
        aria-label="Enable background notifications"
      >
        {pushPerm === 'granted' ? <Bell className="h-3 w-3" aria-hidden="true" /> : <BellOff className="h-3 w-3" aria-hidden="true" />}
        {pushPerm === 'granted' ? 'Push on' : 'Push'}
      </button>
    );

  const actions = (
    <>
      {pushToggle}
      {sortToggle}
      {refresh}
    </>
  );

  return (
    <PanelShell icon={<Inbox className="h-4 w-4 text-blue-500" />} title="Needs you" subtitle={subtitle} actions={actions}>
      {/* Loading */}
      {!loaded && !error && (
        <div className="space-y-2 animate-pulse">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-14 rounded-lg bg-gray-100 dark:bg-gray-800" />
          ))}
        </div>
      )}

      {loaded && error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loaded && !error && (
        <>
          {/* Confident calm state — not a sad empty box. */}
          {items.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20 px-6 py-10 text-center">
              <CheckCircle2 className="h-8 w-8 text-emerald-500" aria-hidden="true" />
              <div className="text-base font-semibold text-emerald-700 dark:text-emerald-300">
                All clear — {working} agent{working === 1 ? '' : 's'} running clean
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                {capacity.headline}
                {idle > 0 ? ` · ${idle} idle` : ''}
                {usage?.costUsd != null ? ` · $${usage.costUsd.toFixed(2)} spent` : ''}
              </div>
            </div>
          )}

          {/* Quick fleet stats — always present so the panel is never empty. */}
          {items.length > 0 && (
            <div className="flex flex-wrap gap-3">
              <StatTile label="Needs you" value={items.length} sub={`${critical.length} critical · ${warn.length} warn`} tone={verdict === 'critical' ? 'critical' : verdict === 'warn' ? 'warn' : 'success'} />
              <StatTile label="Capacity" value={`${capacity.used}/${capacity.cap}`} sub={capacity.roomFor > 0 ? `room for ${capacity.roomFor}` : 'at cap'} tone={capacity.verdict === 'critical' ? 'critical' : capacity.verdict === 'warn' ? 'warn' : 'success'} />
              <StatTile label="Working" value={working} sub={`${idle} idle · ${agents.length} total`} tone="neutral" />
              {usage?.costUsd != null && <StatTile label="Spend" value={`$${usage.costUsd.toFixed(2)}`} sub="recent runs" tone="info" />}
            </div>
          )}

          {/* Grouped (or, in "longest waiting" mode, single-ranked) attention rows. */}
          {sections.map(({ key, title, rows }) => {
            return (
              <SectionCard key={key} title={title} right={`${rows.length}`}>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {rows.map((item) => (
                    <div key={item.id}>
                      <AttentionRow item={item} onAction={onAction} busy={busyId === item.id} />
                      {/* Inline composer, opened by the Answer or Steer action. */}
                      {answering?.id === item.id && (
                        <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 px-4 py-3">
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                              {answering.action?.kind === 'steer' ? 'Steer this agent' : 'Your answer'}
                            </span>
                            <button
                              onClick={() => { setAnswering(null); setAnswerText(''); }}
                              className="rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                              aria-label="Cancel"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                          <textarea
                            ref={answerRef}
                            value={answerText}
                            onChange={(e) => setAnswerText(e.target.value)}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitAnswer(); }
                              if (e.key === 'Escape') { setAnswering(null); setAnswerText(''); }
                            }}
                            rows={2}
                            placeholder={answering.action?.kind === 'steer' ? 'Type a redirect for this agent…' : 'Type your reply to unblock this agent…'}
                            className="w-full resize-y rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2.5 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                          />
                          <div className="mt-2 flex items-center justify-between">
                            <button
                              onClick={() => openConsole(item.agentId)}
                              className="text-[11px] text-amber-600 dark:text-amber-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                            >
                              Open full console
                            </button>
                            <button
                              onClick={submitAnswer}
                              disabled={!answerText.trim()}
                              className="flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Send className="h-3 w-3" aria-hidden="true" />
                              Send (⌘↵)
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </SectionCard>
            );
          })}
        </>
      )}
    </PanelShell>
  );
};
