/**
 * ActiveWorkPane — the single answer to "what is being worked on right now?"
 * AND the single place to do something about it.
 *
 * Every other panel answers a slice: Needs-you shows blockers, Fleet-health
 * shows capacity, Automation shows what the loops did. None of them joins the
 * live roster to the plans it's executing, so the plain question — "which plan
 * is an agent on, doing what, how far along?" — had no home. This pane is that
 * home. It LEADS WITH A VERDICT and renders the activeWork() join (insights.ts):
 * one row per plan/feature, the plan's human title up front, each attached agent
 * with its live activity, progress, and — the spine — THE ONE ACTION that moves
 * it: answer the blocker, land the ready unit, restart the crash, staff the
 * dropped plan, or open the console. The action is computed by activeWorkAction()
 * so the row and the assistant's digest never disagree about the next move.
 *
 * Roster + features both come from the live WS (TaskContext), so the pane is
 * instant and never disagrees with the assistant — which reads the SAME join via
 * activeWorkDigest().
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radar, RefreshCw, FolderGit2, GitBranch, MessageSquare, Send, GitMerge, RotateCw, UserPlus, ExternalLink, Loader2, X, type LucideIcon } from 'lucide-react';
import { apiJson, jsonInit } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import { answerCommand, restartCommand } from '../lib/agent-control';
import { activeWork, activeWorkAction, ACTIVE_WORK_STATUS_LABEL, type ActiveWorkItem, type ActiveWorkStatus, type ActiveWorkAction, type ActiveWorkActionKind, type ActiveWorkAgentLine } from '../lib/insights';
import { PanelShell, VerdictBadge, SectionCard, StatTile, relativeAge, toneClasses, type Tone } from './ui';

const STATUS_TONE: Record<ActiveWorkStatus, Tone> = {
  errored: 'critical',
  blocked: 'critical',
  'land-ready': 'warn',
  working: 'success',
  idle: 'neutral',
};

const AGENT_STATUS_TONE: Record<ActiveWorkAgentLine['status'], Tone> = {
  error: 'critical',
  input: 'critical',
  working: 'success',
  starting: 'info',
  idle: 'neutral',
  stopped: 'neutral',
};

const ACTION_ICON: Record<ActiveWorkActionKind, LucideIcon> = {
  answer: Send,
  land: GitMerge,
  restart: RotateCw,
  staff: UserPlus,
  view: ExternalLink,
};

/** The three buckets the rows group into, in priority order. */
const GROUPS: { key: string; title: string; match: (s: ActiveWorkStatus) => boolean }[] = [
  { key: 'needs', title: 'Needs you — blocking work', match: (s) => s === 'errored' || s === 'blocked' },
  { key: 'flight', title: 'In flight', match: (s) => s === 'working' || s === 'land-ready' },
  { key: 'idle', title: 'Idle / un-staffed', match: (s) => s === 'idle' },
];

/** Stable per-item key — also the answer-composer + busy-state key. Matches the activeWork() row identity. */
function itemKey(item: ActiveWorkItem): string {
  return item.featureId ?? `agent:${item.agents[0]?.id ?? item.title}`;
}

function repoTail(repo: string): string {
  return repo.split(/[\\/]/).filter(Boolean).at(-1) || repo;
}

function ProgressBar({ done, total, tone }: { done: number; total: number; tone: Tone }) {
  if (!total) return null;
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const t = toneClasses(tone);
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
        <div className={`h-full rounded-full ${t.dot} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="flex-shrink-0 text-[11px] tabular-nums text-gray-400">{done}/{total}</span>
    </div>
  );
}

/** The one move a row offers — primary (blue) for mutating actions, ghost for "just open it". */
function RowAction({ action, busy, onClick }: { action: ActiveWorkAction; busy: boolean; onClick: () => void }) {
  const Icon = ACTION_ICON[action.kind];
  const primary = action.kind !== 'view';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={busy}
      className={`flex flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
        primary
          ? 'bg-blue-600 text-white hover:bg-blue-700'
          : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
      }`}
      title={action.label}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Icon className="h-3 w-3" aria-hidden="true" />}
      {action.label}
    </button>
  );
}

function AgentChip({ line, onOpen }: { line: ActiveWorkAgentLine; onOpen: (id: string) => void }) {
  const t = toneClasses(AGENT_STATUS_TONE[line.status]);
  const live = line.status === 'working' || line.status === 'starting';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen(line.id); }}
      className="group flex max-w-full items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800"
      title={`Open ${line.name}'s console`}
    >
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${t.dot} ${live ? 'animate-pulse' : ''}`} aria-hidden="true" />
      <span className="flex-shrink-0 text-xs font-medium text-gray-700 dark:text-gray-200">{line.name}</span>
      {line.note && <span className="truncate text-[11px] text-gray-400">· {line.note}</span>}
      {line.todo && line.todo.total > 0 && (
        <span className="flex-shrink-0 text-[11px] tabular-nums text-gray-400">· {line.todo.done}/{line.todo.total}</span>
      )}
      <MessageSquare className="h-3 w-3 flex-shrink-0 text-gray-300 transition-colors group-hover:text-blue-500 dark:text-gray-600" aria-hidden="true" />
    </button>
  );
}

function ActiveRow({
  item,
  action,
  busy,
  onOpenFeature,
  onOpenAgent,
  onAction,
}: {
  item: ActiveWorkItem;
  action: ActiveWorkAction;
  busy: boolean;
  onOpenFeature: (item: ActiveWorkItem) => void;
  onOpenAgent: (id: string) => void;
  onAction: (item: ActiveWorkItem, action: ActiveWorkAction) => void;
}) {
  const tone = STATUS_TONE[item.status];
  const t = toneClasses(tone);
  const live = item.status === 'working';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenFeature(item)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenFeature(item); } }}
      className="cursor-pointer px-4 py-3 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:hover:bg-gray-900/60"
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${t.dot} ${live ? 'animate-pulse' : ''}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {/* Title row — the PLAN NAME leads, the ONE action sits at the right. */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{item.title}</span>
            <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${t.pillBg} ${t.pillText}`}>
              {ACTIVE_WORK_STATUS_LABEL[item.status]}
            </span>
            {item.issue?.identifier && (
              <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                {item.issue.identifier}
              </span>
            )}
            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
              <span className="text-[11px] text-gray-400">{relativeAge(item.lastActivity)}</span>
              <RowAction action={action} busy={busy} onClick={() => onAction(item, action)} />
            </div>
          </div>

          {/* Headline — the one sentence that says what's happening. */}
          <div className="mt-0.5 truncate text-xs text-gray-600 dark:text-gray-300">{item.headline}</div>

          {/* Meta line — stage + plan dir + repo. */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
            {item.stage && <span className="uppercase tracking-wide">{item.stage}</span>}
            {item.planDir && (
              <span className="flex items-center gap-1 truncate"><FolderGit2 className="h-3 w-3 flex-shrink-0" aria-hidden="true" />{item.planDir}</span>
            )}
            <span className="flex items-center gap-1 truncate"><GitBranch className="h-3 w-3 flex-shrink-0" aria-hidden="true" />{repoTail(item.repo)}</span>
          </div>

          {item.progress && <ProgressBar done={item.progress.done} total={item.progress.total} tone={tone} />}

          {/* Attached agents, each a doorway to its console. */}
          {item.agents.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.agents.map((line) => <AgentChip key={line.id} line={line} onOpen={onOpenAgent} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline answer box for a blocked row — preset options when the request has them, else free text. */
function AnswerComposer({
  item,
  action,
  value,
  onChange,
  onSubmit,
  onCancel,
  onOpenConsole,
  inputRef,
}: {
  item: ActiveWorkItem;
  action: ActiveWorkAction;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onOpenConsole: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const line = item.agents.find((l) => l.requestId === action.requestId);
  const options = line?.options ?? [];
  return (
    <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-900/60">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">Your answer{line ? ` · ${line.name}` : ''}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className="rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-200"
          aria-label="Cancel answer"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {options.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={(e) => { e.stopPropagation(); onSubmit(opt); }}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200 dark:hover:border-blue-700 dark:hover:bg-blue-950/40"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSubmit(value); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        rows={2}
        placeholder={line?.placeholder ?? 'Type your reply to unblock this agent…'}
        className="w-full resize-y rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
      />
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={(e) => { e.stopPropagation(); onOpenConsole(); }}
          className="text-[11px] text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
        >
          Open full console
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSubmit(value); }}
          disabled={!value.trim()}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3 w-3" aria-hidden="true" />
          Send (⌘↵)
        </button>
      </div>
    </div>
  );
}

export const ActiveWorkPane: React.FC = () => {
  const { agents, features, tasks, connected, reload, selectTask, setView, subscribeConsole, setIsChatOpen, sendConsoleCommand, showToast } = useTaskContext();

  const items = useMemo(() => activeWork(agents, features), [agents, features]);

  const [answeringKey, setAnsweringKey] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (answeringKey) answerRef.current?.focus();
  }, [answeringKey]);

  const counts = useMemo(() => ({
    total: items.length,
    working: items.filter((i) => i.status === 'working').length,
    needs: items.filter((i) => i.status === 'errored' || i.status === 'blocked').length,
    landReady: items.filter((i) => i.status === 'land-ready').length,
    idle: items.filter((i) => i.status === 'idle').length,
  }), [items]);

  // ── actions ────────────────────────────────────────────────────────────────

  const openAgent = useCallback((id?: string) => {
    if (id) subscribeConsole(id);
    setIsChatOpen(true);
  }, [subscribeConsole, setIsChatOpen]);

  const openFeature = useCallback((item: ActiveWorkItem) => {
    if (!item.featureId) {
      const first = item.agents[0];
      if (first) { subscribeConsole(first.id); setIsChatOpen(true); }
      return;
    }
    const task = tasks.find((t) => t.sourceId === item.featureId) ?? tasks.find((t) => t.id === item.featureId);
    if (task) { selectTask(task.id); setView('tasks'); }
  }, [tasks, selectTask, setView, subscribeConsole, setIsChatOpen]);

  const submitAnswer = useCallback((_item: ActiveWorkItem, action: ActiveWorkAction, value: string) => {
    if (!action.agentId || !action.requestId || !value.trim()) return;
    sendConsoleCommand(answerCommand(action.agentId, action.requestId, value.trim()));
    showToast('Answer sent — agent unblocking', 'success');
    setAnsweringKey(null);
    setAnswerText('');
    void reload();
  }, [sendConsoleCommand, showToast, reload]);

  const land = useCallback(async (item: ActiveWorkItem, action: ActiveWorkAction) => {
    const key = itemKey(item);
    const url = item.featureId
      ? `/api/features/${encodeURIComponent(item.featureId)}/land`
      : action.agentId
        ? `/api/agents/${encodeURIComponent(action.agentId)}/land`
        : null;
    if (!url) return;
    setBusyKey(key);
    type LandResult = { ok: boolean; merged?: boolean; detail?: string; message?: string };
    try {
      const res = await apiJson<LandResult>(url, jsonInit('POST', {})).catch((e: Error): LandResult => ({ ok: false, detail: e.message }));
      if (res.ok) showToast(res.merged ? 'Landed and merged' : 'Landed', 'success');
      else showToast(res.detail || res.message || 'Land blocked — proof gate not satisfied', 'error');
    } finally {
      setBusyKey(null);
      void reload();
    }
  }, [showToast, reload]);

  const staff = useCallback(async (item: ActiveWorkItem) => {
    if (!item.featureId) return;
    const key = itemKey(item);
    setBusyKey(key);
    try {
      await apiJson(`/api/features/${encodeURIComponent(item.featureId)}/agents`, jsonInit('POST', {
        repo: item.repo,
        task: [
          `Implement: ${item.title}`,
          '',
          `Feature id: ${item.featureId}`,
          'Use the plan documents as implementation context. Keep changes scoped to the selected plan and leave verification evidence.',
        ].join('\n'),
      }));
      showToast(`Staffed a unit on "${item.title}"`, 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not staff a unit', 'error');
    } finally {
      setBusyKey(null);
      void reload();
    }
  }, [showToast, reload]);

  const runAction = useCallback((item: ActiveWorkItem, action: ActiveWorkAction) => {
    switch (action.kind) {
      case 'answer':
        setAnsweringKey(itemKey(item));
        setAnswerText('');
        break;
      case 'land':
        void land(item, action);
        break;
      case 'restart':
        if (action.agentId) { sendConsoleCommand(restartCommand(action.agentId)); showToast('Restart sent', 'success'); }
        break;
      case 'staff':
        void staff(item);
        break;
      case 'view':
        openAgent(action.agentId);
        break;
    }
  }, [land, staff, openAgent, sendConsoleCommand, showToast]);

  // ── verdict ────────────────────────────────────────────────────────────────

  const verdict = counts.needs > 0 ? 'critical' : counts.landReady > 0 ? 'warn' : 'healthy';
  const verdictText = counts.total === 0
    ? 'Nothing in flight'
    : counts.needs > 0
      ? `${counts.needs} blocking`
      : `${counts.working} in flight`;

  const subtitle = (
    <span className="flex items-center gap-2">
      <VerdictBadge verdict={verdict}>{verdictText}</VerdictBadge>
      <span className="text-gray-400">·</span>
      <span>{counts.total} active {counts.total === 1 ? 'item' : 'items'}</span>
      {!connected && <span className="text-red-500 dark:text-red-400">· daemon offline</span>}
    </span>
  );

  const refresh = (
    <button
      onClick={() => void reload()}
      className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  return (
    <PanelShell icon={<Radar className="h-4 w-4 text-blue-500" />} title="Active work" subtitle={subtitle} actions={refresh}>
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-6 py-12 text-center dark:border-gray-800 dark:bg-gray-900/40">
          <Radar className="h-8 w-8 text-gray-400" aria-hidden="true" />
          <div className="text-base font-semibold text-gray-700 dark:text-gray-200">Nothing is being worked on</div>
          <div className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
            No live agents and no in-progress plans. Pick a plan from Tasks and dispatch a unit, or check Needs you for anything waiting.
          </div>
          <button
            onClick={() => setView('tasks')}
            className="mt-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Go to Tasks
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <StatTile label="Active" value={counts.total} sub={`${counts.working} working`} tone={verdict === 'critical' ? 'critical' : verdict === 'warn' ? 'warn' : 'success'} />
            <StatTile label="Needs you" value={counts.needs} sub={counts.needs ? 'blocked or errored' : 'all clear'} tone={counts.needs ? 'critical' : 'success'} />
            <StatTile label="Ready to land" value={counts.landReady} sub={counts.landReady ? 'awaiting confirm' : '—'} tone={counts.landReady ? 'warn' : 'neutral'} />
            <StatTile label="Un-staffed" value={counts.idle} sub={counts.idle ? 'plans with no agent' : '—'} tone={counts.idle ? 'info' : 'neutral'} />
          </div>

          {GROUPS.map(({ key, title, match }) => {
            const rows = items.filter((i) => match(i.status));
            if (rows.length === 0) return null;
            return (
              <SectionCard key={key} title={title} right={`${rows.length}`}>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {rows.map((item) => {
                    const k = itemKey(item);
                    const action = activeWorkAction(item);
                    return (
                      <div key={k}>
                        <ActiveRow
                          item={item}
                          action={action}
                          busy={busyKey === k}
                          onOpenFeature={openFeature}
                          onOpenAgent={openAgent}
                          onAction={runAction}
                        />
                        {answeringKey === k && (
                          <AnswerComposer
                            item={item}
                            action={action}
                            value={answerText}
                            onChange={setAnswerText}
                            onSubmit={(v) => submitAnswer(item, action, v)}
                            onCancel={() => { setAnsweringKey(null); setAnswerText(''); }}
                            onOpenConsole={() => openAgent(action.agentId)}
                            inputRef={answerRef}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            );
          })}
        </>
      )}
    </PanelShell>
  );
};
