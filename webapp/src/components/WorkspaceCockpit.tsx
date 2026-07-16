/**
 * WorkspaceCockpit — THE UNIFIED FLEET VIEW (plans/orchestration/GRAPH-FOLD.md §6).
 *
 * WorkspaceCockpit started as "one screen per agent" (reference C, UI-REFERENCES.md): a roster to
 * pick a unit, its live transcript + composer to steer it, and the land/PR rail. The fold dissolves
 * the two panels that used to sit BESIDE it — AttentionPanel ("needs you") and ActiveWorkPane
 * ("active work") — INTO this same roster, because all three were answering overlapping questions
 * about the same live roster with three different sorts and three different action grammars. Now
 * there is one roster, state-GROUPED (§6a):
 *
 *   NEEDS YOU · LAND READY · WORKING · IDLE/DONE (collapsed) · UNSTAFFED PLANS (trailing)
 *
 * — ranked by the SAME `attentionItems`/`activeWork` syntheses (insights.ts) the deleted panels
 * used, recomposed by `buildFleetRoster` (lib/fleetRoster.ts) so this view can never disagree with
 * either panel's old verdict. NEEDS YOU never collapses and is pinned at the top of the rail (§6g);
 * everything else scrolls underneath it.
 *
 * Two-tier inline answering (§6b): a roster row with PRESET options answers in one click, in place,
 * with no selection change (tier 1 — AttentionRow's own grammar, just inlined). A row needing free
 * text just selects itself so the detail pane's pinned question banner + Composer (now primed with
 * the request's own placeholder) can answer it (tier 2). Both tiers resolve the SAME `requestId`, so
 * whichever one the operator uses, the other disappears with it.
 *
 * Salvaged from the deleted panels (§6c): the plan⇄agent join (`activeWork`) becomes each row's
 * line-2 plan chip + progress bar and the trailing UNSTAFFED PLANS group; the fleet activity
 * narrative (`fleetActivityRollup`) and the capacity synthesis (`computeCapacity`, now also the
 * FactoryStatusStrip's capacity chip) move into this header; per-plan progress reappears in the
 * detail header. Reused verbatim: TranscriptTimeline + Composer (chat/) for the center pane and
 * AgentLandControls + validationBadge/confidenceBadge (agent-badges.ts) for the land rail.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell,
  BellOff,
  ChevronDown,
  FolderGit2,
  GitBranch,
  GitMerge,
  Layers,
  LayoutPanelLeft,
  Search,
  Terminal as TerminalIcon,
  UserPlus,
} from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { PageContextScope } from '../context/PageContext';
import { deriveFleetPageContext } from '../lib/pageContextDerive';
import { AgentLandControls } from './chat/AgentMetaBar';
import { validationBadge, confidenceBadge, prStateBadgeLabel, isValidatorHeld } from '../lib/agent-badges';
import { canLand, answerCommand, interruptCommand, interruptibleAgents, restartCommand, setModelCommand } from '../lib/agent-control';
import { apiJson, jsonInit } from '../lib/api';
import { enablePush, pushPermission } from '../lib/push';
import { useAgentDiffs } from '../hooks/useAgentDiffs';
import { aggregateDiffCounts, countDiffLines } from '../lib/diff-stat';
import { TranscriptTimeline, agentIsRunning, transcriptIsRunning } from './chat/TranscriptTimeline';
import { Composer, type ModelOption } from './chat/Composer';
import { deriveSuggestionChips } from './AssistantChat';
import { StatusChip, Kbd, MonoLabel, PanelSection, DiffStat } from './kit';
import { toneClasses } from './ui';
import {
  attentionItems,
  activeWork,
  activeWorkAction,
  computeCapacity,
  capacityFractionLabel,
  detectCollisions,
  type AttentionItem,
  type ActiveWorkItem,
  type GovernancePayload,
  type UsagePayload,
  type ServerActionItem,
} from '../lib/insights';
import { fleetActivityRollup } from '../lib/fleetActivity';
import { buildFleetRoster, defaultSelection, calmLine, type FleetRoster, type FleetAgentRow, type FleetUnstaffedRow } from '../lib/fleetRoster';
import type { AgentDTO } from '../lib/dto';

const EMPTY_TRANSCRIPT: import('../lib/dto').TranscriptEntry[] = [];

interface ActionItemsResponse {
  items: ServerActionItem[];
  generatedAt: number;
}

/** Cap on visible WORKING rows before a "show N more" expander — a dependency-free stand-in for
 *  real windowed virtualization (§6d "WORKING virtualizes"): this repo has no virtualization lib
 *  yet, so a bounded initial render + explicit expand keeps the DOM small without adding one. */
const WORKING_VISIBLE_CAP = 25;

function shortBranch(branch?: string): string {
  return branch ? branch.replace(/^squad\//, '') : '';
}

function matchesFilter(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

// ── shared row furniture ──────────────────────────────────────────────────────

/** Row line 2 — the activeWork plan join (§6c): plan title + progress, when this agent is
 *  attached to a feature/plan. Absent for orphan (un-planned) agents. */
const PlanLine: React.FC<{ item?: ActiveWorkItem }> = ({ item }) => {
  if (!item) return null;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500">
      <FolderGit2 className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{item.title}</span>
      {item.progress && item.progress.total > 0 && (
        <span className="ml-auto flex-shrink-0 tabular-nums">{item.progress.done}/{item.progress.total}</span>
      )}
    </div>
  );
};

/** Tier-1 inline answer: one-click preset options rendered directly on the roster row (§6b) —
 *  answers WITHOUT changing the selection. Only rendered when the pending request actually
 *  carries options; free-text answers are tier 2 (the detail pane's banner + Composer).
 *
 *  Ember discipline (taste-review nit 1): hover is amber, matching the trailing action chip's
 *  "act here" grammar — one answer color, not two (the selection highlight below uses the
 *  brand's ember `--wf-accent`, a DIFFERENT signal — "you're looking at this" vs "act on this"). */
const InlineOptions: React.FC<{ options: string[]; onPick: (opt: string) => void }> = ({ options, onPick }) => (
  <div className="mt-1.5 flex flex-wrap gap-1">
    {options.map((opt) => (
      <button
        key={opt}
        onClick={(e) => { e.stopPropagation(); onPick(opt); }}
        className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-700 transition-colors hover:border-amber-400 hover:bg-amber-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200 dark:hover:border-amber-600 dark:hover:bg-amber-950/30"
      >
        {opt}
      </button>
    ))}
  </div>
);

/** The row's one-move trailing chip. "Land" deliberately never fires the mutation from here —
 *  land stays in the right rail (§6b) — clicking it (like Answer/View/Vetoed-Review) just selects
 *  the row so the detail pane + LandRail take over; only Restart and Raise-cap act immediately.
 *
 *  Ember discipline (taste-review nit 1): a busy NEEDS YOU group used to render a solid amber-500
 *  chip on EVERY actionable row at once — a wash, not a spark. `mostUrgent` is true only for the
 *  single top-ranked row (attn is already severity→recency sorted, so index 0 of the visible NEEDS
 *  YOU rows IS the most urgent); every other row's action — even an "Answer"/"Restart" kind that
 *  would otherwise qualify — demotes to the same outline treatment as View/Land. */
const RowActionChip: React.FC<{ action: AttentionItem['action']; onClick: () => void; mostUrgent: boolean }> = ({ action, onClick, mostUrgent }) => {
  if (!action) return null;
  const solid = mostUrgent && (action.kind === 'answer' || action.kind === 'steer' || action.kind === 'restart');
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`flex-shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
        solid
          ? 'bg-amber-500 text-white hover:bg-amber-600'
          : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300'
      }`}
    >
      {action.label}
    </button>
  );
};

/** One roster row backed by a live agent — the NEEDS YOU / LAND READY / WORKING / IDLE groups all
 *  render through this, only the `row.group`-derived furniture (detail line, inline options,
 *  action chip) changes. Human decision it serves: "which unit do I look at / act on next." */
const RosterAgentRow: React.FC<{
  row: FleetAgentRow;
  selected: boolean;
  diffCounts: { added: number; removed: number };
  mostUrgent?: boolean;
  onSelect: () => void;
  onRowAction: (row: FleetAgentRow) => void;
  onInlineAnswer: (agentId: string, requestId: string, value: string) => void;
  onIntervene: (agentId: string) => void;
}> = ({ row, selected, diffCounts, mostUrgent = false, onSelect, onRowAction, onInlineAnswer, onIntervene }) => {
  const { agent, attn, planItem } = row;
  const pending = agent.pending[0];
  const showInlineOptions = attn?.kind === 'blocked' && !!pending?.options?.length;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full flex-col items-start gap-1 border-b border-gray-100 px-3 py-2 text-left transition-colors dark:border-ink-border ${
        selected ? 'bg-[color:var(--wf-accent-soft)]' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-ink-surface/60'
      }`}
    >
      <div className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">{agent.name}</span>
        {/* Ember discipline (brand.md): solid ember reserved for the selected/streaming thing. */}
        <StatusChip
          status={agent.status}
          variant={!selected && (agent.status === 'working' || agent.status === 'starting') ? 'dim' : undefined}
        />
        {(agent.status === 'input' || agent.status === 'error') && (
          <button
            onClick={(e) => { e.stopPropagation(); onIntervene(agent.id); }}
            className="flex-shrink-0 rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            style={{ minHeight: '44px', minWidth: '44px' }}
          >
            Step in
          </button>
        )}
      </div>
      <div className="flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
        {agent.branch && (
          <span className="flex min-w-0 items-center gap-1 truncate font-mono">
            <GitBranch className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
            {shortBranch(agent.branch)}
          </span>
        )}
        <DiffStat added={diffCounts.added} removed={diffCounts.removed} className="ml-auto" />
      </div>
      <PlanLine item={planItem} />
      {attn?.detail && (
        <div className={`w-full truncate text-[11px] ${attn.severity === 'critical' ? 'text-red-500 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`} title={attn.detail}>
          {attn.detail}
        </div>
      )}
      {showInlineOptions && (
        <InlineOptions options={pending!.options!} onPick={(opt) => onInlineAnswer(agent.id, pending!.id, opt)} />
      )}
      {/* Redundant-affordance fix (taste-review nit 2): when the row already renders real
       *  one-click inline options, the trailing "Answer" chip only ever re-selected the row —
       *  a louder, do-nothing-extra duplicate of a control that's already right there (and the
       *  whole row is itself a click target). Suppressing it read cleaner live than relabeling to
       *  "Open": the row's own click-to-select is self-evident (cursor-pointer + hover state), so
       *  a second, differently-worded chip for the exact same "select this row" move was still
       *  noise — it just moved the redundancy instead of removing it. Every other action kind
       *  (Restart, Steer, Land, View, Raise-cap) keeps its chip; only the inline-options case
       *  had a genuine duplicate. */}
      {attn?.action && !showInlineOptions && (
        <div className="mt-0.5 flex w-full justify-end">
          <RowActionChip action={attn.action} onClick={() => onRowAction(row)} mostUrgent={mostUrgent} />
        </div>
      )}
    </div>
  );
};

/** One collision/resource "needs you" row with no single owning agent (§6c: AttentionPanel's
 *  extras). Rendered above the per-agent rows in the NEEDS YOU group. */
const VirtualNeedsRow: React.FC<{ item: AttentionItem; onOpen: (agentId?: string) => void; onRaiseCap: () => void }> = ({ item, onOpen, onRaiseCap }) => {
  const t = toneClasses(item.severity === 'critical' ? 'critical' : 'warn');
  return (
    <div className="flex items-start gap-2 border-b border-gray-100 px-3 py-2 dark:border-ink-border">
      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
      <button
        type="button"
        onClick={() => onOpen(item.agentId)}
        disabled={!item.agentId}
        className="min-w-0 flex-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-default"
      >
        <div className="truncate text-[12px] font-medium text-gray-900 dark:text-gray-100">{item.title}</div>
        {item.detail && <div className="truncate text-[11px] text-gray-500 dark:text-gray-400" title={item.detail}>{item.detail}</div>}
      </button>
      {item.action?.kind === 'raise-cap' && <RowActionChip action={item.action} onClick={onRaiseCap} mostUrgent={false} />}
    </div>
  );
};

/** Trailing "un-staffed plan" row — plan work underway with zero agents attached (§6a/c). Its one
 *  action is `activeWorkAction`'s own move (`staff`), literally reused (not re-derived). */
const UnstaffedRow: React.FC<{ row: FleetUnstaffedRow; busy: boolean; onStaff: (item: ActiveWorkItem) => void; onOpen: (item: ActiveWorkItem) => void }> = ({ row, busy, onStaff, onOpen }) => {
  const action = activeWorkAction(row.item);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row.item)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row.item); } }}
      className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:border-ink-border dark:hover:bg-ink-surface/60"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">{row.item.title}</div>
        <div className="truncate text-[11px] text-gray-400 dark:text-gray-500">{row.item.stage ?? 'un-staffed'}</div>
      </div>
      {action.kind === 'staff' && (
        <button
          onClick={(e) => { e.stopPropagation(); onStaff(row.item); }}
          disabled={busy}
          className="flex flex-shrink-0 items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <UserPlus className="h-3 w-3" aria-hidden="true" />
          {busy ? '…' : action.label}
        </button>
      )}
    </div>
  );
};

/** A group section header — plain for the always-expanded groups, a toggle for IDLE/DONE (the
 *  only group collapsed by default, §6a/d).
 *
 *  `tone="ember"` (taste-review nit 3) is reserved for the pinned NEEDS YOU header: a faint ember
 *  left-border + tint so it visibly reads as "special" inside the rail rather than looking
 *  identical to LAND READY/WORKING's plain gray headers — it's the one group that never collapses
 *  and is pinned above everything else, so its header should say so at a glance. */
const GroupHeader: React.FC<{ title: string; count: number; collapsed?: boolean; onToggle?: () => void; tone?: 'default' | 'ember' }> = ({ title, count, collapsed, onToggle, tone = 'default' }) => {
  const body = (
    <>
      <MonoLabel>{title}</MonoLabel>
      <span className="text-[10px] text-gray-400">{count}</span>
    </>
  );
  const toneCls = tone === 'ember'
    ? 'border-l-2 border-l-[color:var(--wf-accent)] bg-[color:var(--wf-accent-soft)]'
    : 'bg-gray-50/60 dark:bg-ink-surface/40';
  if (!onToggle) {
    return <div className={`flex items-center gap-2 border-y border-gray-100 px-3 py-1 dark:border-ink-border ${toneCls}`}>{body}</div>;
  }
  return (
    <button
      onClick={onToggle}
      className={`flex w-full items-center gap-2 border-y border-gray-100 px-3 py-1 text-left transition-colors hover:bg-gray-100 dark:border-ink-border dark:hover:bg-ink-surface/70 ${toneCls}`}
      aria-expanded={!collapsed}
    >
      {body}
      <ChevronDown className={`ml-auto h-3 w-3 text-gray-400 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden="true" />
    </button>
  );
};

/** Tier-2 pending-question banner, pinned above the transcript (§6b) — the detail-pane half of the
 *  two-tier answer. Renders only when the SELECTED agent has a real pending request; answering it
 *  here (or from the row's tier-1 options, or the Composer below) all resolve the same requestId,
 *  so whichever the operator uses, this banner and the row's inline options disappear together. */
const PendingBanner: React.FC<{ agent: AgentDTO; onAnswer: (requestId: string, value: string) => void }> = ({ agent, onAnswer }) => {
  const pending = agent.pending[0];
  if (!pending) return null;
  return (
    <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-900/50 dark:bg-amber-950/20">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
        <Bell className="h-3 w-3" aria-hidden="true" />
        Waiting on you
      </div>
      <div className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">{pending.title}</div>
      {pending.message && pending.message !== pending.title && (
        <div className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{pending.message}</div>
      )}
      {pending.options && pending.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {pending.options.map((opt) => (
            <button
              key={opt}
              onClick={() => onAnswer(pending.id, opt)}
              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800 dark:bg-gray-950 dark:text-amber-300 dark:hover:bg-amber-950/40"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      {(!pending.options || pending.options.length === 0) && (
        <div className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">Type your reply in the composer below.</div>
      )}
    </div>
  );
};

/** Right rail — the PR/land panel (unchanged from the original cockpit; §6b: "Land stays in the
 *  right rail" — no roster row ever performs the land mutation directly). */
const LandRail: React.FC<{
  agent?: AgentDTO;
  diffs: { file: string; status?: string; diff?: string }[];
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}> = ({ agent, diffs, showToast }) => {
  const validation = agent ? validationBadge(agent) : null;
  const confidence = agent ? confidenceBadge(agent) : null;
  const totals = useMemo(() => aggregateDiffCounts(diffs), [diffs]);
  const landable = agent ? canLand(agent) : false;

  return (
    <div className="flex h-full w-80 flex-shrink-0 flex-col gap-2 overflow-y-auto border-l border-gray-200 bg-gray-50/60 p-2 dark:border-ink-border dark:bg-ink">
      <PanelSection
        title="Land"
        right={
          agent?.prState ? (
            <StatusChip status={agent.prState} />
          ) : agent?.landReady && !isValidatorHeld(agent) ? (
            <StatusChip status="done" />
          ) : agent?.landReady && isValidatorHeld(agent) ? (
            // A vetoed or inconclusive verdict must never read as "done" — the fail-open
            // isValidatorHeld exists to close (agent-badges.ts). The `validation` pill below already
            // names the verdict; this chip must not contradict it.
            <StatusChip status="held" tone="attention" />
          ) : null
        }
      >
        <div className="flex flex-col gap-2 p-3">
          {!agent ? (
            <p className="text-[12px] text-gray-400">Select an agent to see its land readiness.</p>
          ) : !landable ? (
            <p className="text-[12px] text-gray-400">No branch/worktree of its own — nothing to land.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {validation && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${validation.cls}`} title={validation.title}>
                    {validation.label}
                  </span>
                )}
                {confidence && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${confidence.cls}`} title={confidence.title}>
                    {confidence.label}
                  </span>
                )}
                {!validation && !confidence && <span className="text-[11px] text-gray-400">No run-end verdict yet</span>}
              </div>
              {agent.prUrl && (
                <a
                  href={agent.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-8 items-center gap-1.5 truncate text-[12px] font-medium text-[color:var(--wf-accent-link,var(--wf-accent))] hover:underline"
                >
                  <GitMerge className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  PR #{agent.prNumber} · {agent.prState ? prStateBadgeLabel(agent.prState) : 'open'}
                </a>
              )}
              <div className="flex items-center gap-2">
                <AgentLandControls agent={agent} showToast={showToast} />
              </div>
            </>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Changes" right={<DiffStat added={totals.added} removed={totals.removed} />} className="min-h-0 flex-1">
        {diffs.length === 0 ? (
          <p className="p-3 text-[12px] text-gray-400">No changed files{agent ? '' : ' — select an agent'}.</p>
        ) : (
          <ul className="divide-y divide-gray-100 overflow-y-auto dark:divide-gray-900">
            {diffs.map((d) => {
              const counts = countDiffLines(d.diff);
              return (
                <li key={d.file} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-gray-700 dark:text-gray-300" title={d.file}>
                    {d.status ? `${d.status} ` : ''}
                    {d.file}
                  </span>
                  <DiffStat added={counts.added} removed={counts.removed} />
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>

      {/* Terminal tab — deliberately deferred (no PTY backend); see the original cockpit's note. */}
      <PanelSection title="Run" bodyClassName="p-0">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-[11px] dark:border-ink-border">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">Transcript</span>
          <span className="ml-auto flex items-center gap-1 text-gray-400 dark:text-gray-600" title="No PTY backend exists yet — deliberately deferred">
            <TerminalIcon className="h-3 w-3" aria-hidden="true" />
            Terminal
          </span>
        </div>
      </PanelSection>
    </div>
  );
};

/**
 * WorkspaceCockpit — the composed Fleet screen: state-grouped roster · transcript+composer ·
 * land rail.
 */
export const WorkspaceCockpit: React.FC = () => {
  const { agents, features, audit, tasks, allTasks, transcripts, sendConsoleCommand, subscribeConsole, showToast, selectTask, setView, reload, openIntervene } = useTaskContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ label: 'omp default', value: '' }]);
  const [stopPending, setStopPending] = useState(false);
  const [idleExpanded, setIdleExpanded] = useState(false);
  const [workingExpanded, setWorkingExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const [staffingId, setStaffingId] = useState<string | null>(null);
  const [pushPerm, setPushPerm] = useState<NotificationPermission | 'unsupported'>(() => pushPermission());

  // ── polled fleet-health signals (governance/usage/action-items) — same cadence + shape the
  // deleted AttentionPanel used, feeding the SAME attentionItems synthesis. ──────────────────────
  const [gov, setGov] = useState<GovernancePayload | null>(null);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [serverItems, setServerItems] = useState<ServerActionItem[]>([]);

  const loadFleetHealth = useCallback(async () => {
    const [g, u, ai] = await Promise.all([
      apiJson<GovernancePayload>('/api/governance').catch(() => null),
      apiJson<UsagePayload>('/api/usage?limit=200').catch(() => null),
      apiJson<ActionItemsResponse>('/api/action-items').catch(() => ({ items: [], generatedAt: 0 })),
    ]);
    setGov(g);
    setUsage(u);
    setServerItems(ai.items ?? []);
  }, []);

  useEffect(() => {
    void loadFleetHealth();
    const interval = setInterval(() => void loadFleetHealth(), 10_000);
    return () => clearInterval(interval);
  }, [loadFleetHealth]);

  useEffect(() => {
    void apiJson<{ models?: ModelOption[] }>('/api/models')
      .then((data) => { if (data.models?.length) setModelOptions(data.models); })
      .catch(() => undefined);
  }, []);

  // ── the Fleet roster: state-grouped, joined to plans, ranked by the same syntheses the
  // deleted panels used. ────────────────────────────────────────────────────────────────────────
  const capacity = useMemo(() => computeCapacity(gov), [gov]);
  const collisions = useMemo(() => detectCollisions(usage?.runs, agents), [usage?.runs, agents]);
  const attn = useMemo(
    () => attentionItems({ actionItems: serverItems, agents, capacity, collisions }, { sort: 'severity' }),
    [serverItems, agents, capacity, collisions],
  );
  const workItems = useMemo(() => activeWork(agents, features), [agents, features]);
  const roster: FleetRoster = useMemo(() => buildFleetRoster(agents, attn, workItems), [agents, attn, workItems]);
  const activityRollup = useMemo(() => fleetActivityRollup(audit), [audit]);

  const needsCount = roster.needs.length + roster.virtualNeeds.length;

  // Text filter (§6d dense state) applies across every group — a deliberate search, not automatic
  // hiding, so it's fine for it to also narrow NEEDS YOU.
  const passesFilter = useCallback(
    (row: FleetAgentRow) => !filter.trim() || matchesFilter(row.agent.name, filter) || matchesFilter(row.agent.branch ?? '', filter) || matchesFilter(row.planItem?.title ?? '', filter),
    [filter],
  );
  const filteredNeeds = useMemo(() => roster.needs.filter(passesFilter), [roster.needs, passesFilter]);
  const filteredLand = useMemo(() => roster.land.filter(passesFilter), [roster.land, passesFilter]);
  const filteredWorking = useMemo(() => roster.working.filter(passesFilter), [roster.working, passesFilter]);
  const filteredIdle = useMemo(() => roster.idle.filter(passesFilter), [roster.idle, passesFilter]);
  const filteredUnstaffed = useMemo(
    () => (!filter.trim() ? roster.unstaffed : roster.unstaffed.filter((r) => matchesFilter(r.item.title, filter))),
    [roster.unstaffed, filter],
  );

  // Keyboard Up/Down + default selection traverse agent rows in group order — NEEDS, LAND,
  // WORKING, then IDLE only while expanded (mirrors what's actually visible in the rail).
  const navRows = useMemo(
    () => [...filteredNeeds, ...filteredLand, ...filteredWorking, ...(idleExpanded ? filteredIdle : [])],
    [filteredNeeds, filteredLand, filteredWorking, filteredIdle, idleExpanded],
  );

  // Default/keep-valid selection: prefer the top NEEDS-YOU row (§6d) whenever the current
  // selection is gone or unset; never yank a still-valid manual selection out from under the
  // operator just because the roster re-sorted.
  useEffect(() => {
    if (selectedId && agents.some((a) => a.id === selectedId)) return;
    setSelectedId(defaultSelection(roster));
  }, [agents, roster, selectedId]);

  const selectedAgent = agents.find((a) => a.id === selectedId);
  const selectedPlanItem = selectedAgent ? workItems.find((item) => item.featureId && item.agents.some((l) => l.id === selectedAgent.id)) : undefined;

  useEffect(() => {
    if (selectedAgent) subscribeConsole(selectedAgent.id);
  }, [selectedAgent?.id, subscribeConsole]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (navRows.length === 0) return;
      e.preventDefault();
      const index = navRows.findIndex((r) => r.agent.id === selectedAgent?.id);
      const next = e.key === 'ArrowDown' ? Math.min(navRows.length - 1, index + 1) : Math.max(0, index - 1);
      setSelectedId(navRows[next]?.agent.id ?? null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navRows, selectedAgent?.id]);

  const diffSignals = useMemo(
    () =>
      agents.map((a) => ({
        id: a.id,
        messageCount: a.messageCount,
        status: a.status,
        landReady: a.landReady,
        prState: a.prState,
        validationVerdict: a.validation?.verdict,
      })),
    [agents],
  );
  const diffsById = useAgentDiffs(diffSignals);
  const selectedDiffs = (selectedAgent && diffsById.get(selectedAgent.id)) ?? [];

  const transcriptEntries = selectedAgent ? (transcripts.get(selectedAgent.id) ?? EMPTY_TRANSCRIPT) : EMPTY_TRANSCRIPT;
  const [workExpanded, setWorkExpanded] = useState(false);
  const agentRunning = agentIsRunning(selectedAgent) || transcriptIsRunning(transcriptEntries);
  useEffect(() => { setWorkExpanded(agentRunning); }, [selectedAgent?.id, agentRunning]);

  const isStopShown = !!selectedAgent && interruptibleAgents([selectedAgent]).length > 0;
  const suggestionChips = useMemo(
    () => deriveSuggestionChips({ messages: [], transcriptEntries, selectedTask: undefined, selectedAgent, changedFiles: selectedDiffs.length }),
    [transcriptEntries, selectedAgent, selectedDiffs.length],
  );

  // ── actions ──────────────────────────────────────────────────────────────────────────────────

  const sendAnswer = useCallback((agentId: string, requestId: string, value: string) => {
    sendConsoleCommand(answerCommand(agentId, requestId, value));
    showToast('Answer sent — agent unblocking', 'success');
  }, [sendConsoleCommand, showToast]);

  const enablePushHere = useCallback(async () => {
    if (pushPerm === 'granted') return;
    const result = await enablePush();
    setPushPerm(pushPermission());
    if (result === 'granted') showToast('Background push enabled — a blocked unit will now buzz this device', 'success');
    else if (result === 'denied') showToast('Notification permission denied', 'error');
  }, [pushPerm, showToast]);

  const onRowAction = useCallback((row: FleetAgentRow) => {
    const action = row.attn?.action;
    if (!action) { setSelectedId(row.agent.id); return; }
    switch (action.kind) {
      case 'restart':
        sendConsoleCommand(restartCommand(row.agent.id));
        showToast('Restart sent', 'success');
        break;
      case 'raise-cap':
        showToast('WIP cap is set by OMP_SQUAD_WIP_CAP — raise it and restart the daemon to allow more concurrent agents.', 'info');
        break;
      // answer · steer · view · land: hand off to the detail pane (banner+Composer, or the
      // right rail for land) rather than acting from the row.
      default:
        setSelectedId(row.agent.id);
    }
  }, [sendConsoleCommand, showToast]);

  const onVirtualNeedsOpen = useCallback((agentId?: string) => { if (agentId) setSelectedId(agentId); }, []);
  const onRaiseCap = useCallback(() => {
    showToast('WIP cap is set by OMP_SQUAD_WIP_CAP — raise it and restart the daemon to allow more concurrent agents.', 'info');
  }, [showToast]);

  const openUnstaffed = useCallback((item: ActiveWorkItem) => {
    if (!item.featureId) return;
    // The FLEET is deliberately unscoped — a blocked agent in another repo must never be hidden — so its
    // unstaffed-plan rows can name a task the current project scope excludes. Look it up in `allTasks`;
    // searching the scoped list silently found nothing and the click did nothing. (gpt-5.6-sol)
    const task = allTasks.find((t) => t.sourceId === item.featureId) ?? allTasks.find((t) => t.id === item.featureId);
    if (task) { selectTask(task.id); setView('tasks'); }
  }, [allTasks, selectTask, setView]);

  const staffPlan = useCallback(async (item: ActiveWorkItem) => {
    if (!item.featureId) return;
    setStaffingId(item.featureId);
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
      setStaffingId(null);
      void reload();
    }
  }, [showToast, reload]);

  const handleSend = (text: string) => {
    if (!selectedAgent || !text.trim()) return;
    const pending = selectedAgent.pending[0];
    // The Composer becomes the free-text half of the two-tier answer (§6b) whenever the selected
    // agent has a real pending request — same requestId the row's inline options and the detail
    // banner resolve, so sending here clears all three surfaces together.
    if (pending) sendConsoleCommand(answerCommand(selectedAgent.id, pending.id, text));
    else sendConsoleCommand({ type: 'prompt', id: selectedAgent.id, message: text });
  };
  const handleStop = () => {
    if (!selectedAgent || stopPending) return;
    sendConsoleCommand(interruptCommand(selectedAgent.id));
    setStopPending(true);
    setTimeout(() => setStopPending(false), 8000);
  };
  const handleModelChange = (model: string) => {
    if (!selectedAgent) return;
    sendConsoleCommand(setModelCommand(selectedAgent.id, model));
  };

  const pendingForSelected = selectedAgent?.pending[0];

  // PageContext (Feature 2 D1): roster group counts, the selected agent, NEEDS-YOU ids, and the
  // capacity chip — the exact fields D1 names for Fleet, all local state this component already
  // computed above (no duplicate fetch).
  const pageContext = useMemo(
    () => deriveFleetPageContext({ roster, selectedAgent, capacity, filterText: filter }),
    [roster, selectedAgent, capacity, filter],
  );

  return (
    <PageContextScope value={pageContext}>
    <div className="dark flex h-full min-h-0 w-full bg-ink text-gray-100">
      {/* Left rail — the Fleet roster: state-grouped, NEEDS YOU pinned at top (never collapses,
          never scrolls away — §6g), everything else scrolling underneath. */}
      <div className="flex h-full w-72 flex-shrink-0 flex-col border-r border-gray-200 dark:border-ink-border">
        <div className="flex flex-shrink-0 flex-col gap-1.5 border-b border-gray-200 bg-white px-3 py-2 dark:border-ink-border dark:bg-panel">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
              <MonoLabel>Fleet</MonoLabel>
            </span>
            <div className="flex items-center gap-1.5">
              {pushPerm !== 'unsupported' && (
                <button
                  onClick={() => void enablePushHere()}
                  disabled={pushPerm === 'granted'}
                  className="flex items-center gap-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-default disabled:opacity-60 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                  title={pushPerm === 'granted' ? 'Background push enabled' : 'Enable background push for a blocked unit'}
                  aria-label="Enable background notifications"
                >
                  {pushPerm === 'granted' ? <Bell className="h-3.5 w-3.5" aria-hidden="true" /> : <BellOff className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              )}
              <Kbd keys="↑↓" label="select" />
            </div>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-gray-400">
            <span title={capacity.headline}>{capacityFractionLabel(capacity.used, capacity.cap)} agents</span>
            <span className="truncate" title={activityRollup.headline}>{activityRollup.headline}</span>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter roster…"
              className="w-full rounded-md border border-gray-200 bg-gray-50 py-1 pl-6 pr-2 text-[11px] text-gray-700 outline-none focus:border-amber-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Filter roster"
            />
          </div>
        </div>

        {/* NEEDS YOU — pinned, never collapses. Own scroll cap so a pathological number of
            blocked agents can't swallow the whole rail; everything else scrolls below it. */}
        <div className="flex-shrink-0 border-b border-gray-200 dark:border-ink-border">
          <GroupHeader title="Needs you" count={needsCount} tone="ember" />
          {needsCount === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-emerald-600 dark:text-emerald-400">
              {calmLine(filteredWorking.length, capacity.roomFor)}
            </div>
          ) : (
            <div className="max-h-[45vh] overflow-y-auto">
              {roster.virtualNeeds.map((item) => (
                <VirtualNeedsRow key={item.id} item={item} onOpen={onVirtualNeedsOpen} onRaiseCap={onRaiseCap} />
              ))}
              {filteredNeeds.map((row, i) => (
                <RosterAgentRow
                  key={row.agent.id}
                  row={row}
                  selected={row.agent.id === selectedAgent?.id}
                  diffCounts={aggregateDiffCounts(diffsById.get(row.agent.id) ?? [])}
                  mostUrgent={i === 0}
                  onSelect={() => setSelectedId(row.agent.id)}
                  onRowAction={onRowAction}
                  onInlineAnswer={sendAnswer}
                  onIntervene={openIntervene}
                />
              ))}
            </div>
          )}
        </div>

        {/* Everything else scrolls under the pinned NEEDS YOU header (§6g). */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {agents.length === 0 && roster.unstaffed.length === 0 && (
            <div className="p-4 text-[12px] text-gray-400">No agents in the fleet right now.</div>
          )}

          {filteredLand.length > 0 && (
            <>
              <GroupHeader title="Land ready" count={filteredLand.length} />
              {filteredLand.map((row) => (
                <RosterAgentRow
                  key={row.agent.id}
                  row={row}
                  selected={row.agent.id === selectedAgent?.id}
                  diffCounts={aggregateDiffCounts(diffsById.get(row.agent.id) ?? [])}
                  onSelect={() => setSelectedId(row.agent.id)}
                  onRowAction={onRowAction}
                  onInlineAnswer={sendAnswer}
                  onIntervene={openIntervene}
                />
              ))}
            </>
          )}

          {filteredWorking.length > 0 && (
            <>
              <GroupHeader title="Working" count={filteredWorking.length} />
              {(workingExpanded ? filteredWorking : filteredWorking.slice(0, WORKING_VISIBLE_CAP)).map((row) => (
                <RosterAgentRow
                  key={row.agent.id}
                  row={row}
                  selected={row.agent.id === selectedAgent?.id}
                  diffCounts={aggregateDiffCounts(diffsById.get(row.agent.id) ?? [])}
                  onSelect={() => setSelectedId(row.agent.id)}
                  onRowAction={onRowAction}
                  onInlineAnswer={sendAnswer}
                  onIntervene={openIntervene}
                />
              ))}
              {!workingExpanded && filteredWorking.length > WORKING_VISIBLE_CAP && (
                <button
                  onClick={() => setWorkingExpanded(true)}
                  className="w-full px-3 py-1.5 text-left text-[11px] text-amber-600 hover:underline dark:text-amber-400"
                >
                  Show {filteredWorking.length - WORKING_VISIBLE_CAP} more…
                </button>
              )}
            </>
          )}

          {filteredIdle.length > 0 && (
            <>
              <GroupHeader title="Idle / done" count={filteredIdle.length} collapsed={!idleExpanded} onToggle={() => setIdleExpanded((v) => !v)} />
              {idleExpanded && filteredIdle.map((row) => (
                <RosterAgentRow
                  key={row.agent.id}
                  row={row}
                  selected={row.agent.id === selectedAgent?.id}
                  diffCounts={aggregateDiffCounts(diffsById.get(row.agent.id) ?? [])}
                  onSelect={() => setSelectedId(row.agent.id)}
                  onRowAction={onRowAction}
                  onInlineAnswer={sendAnswer}
                  onIntervene={openIntervene}
                />
              ))}
            </>
          )}

          {filteredUnstaffed.length > 0 && (
            <>
              <GroupHeader title="Unstaffed plans" count={filteredUnstaffed.length} />
              {filteredUnstaffed.map((row) => (
                <UnstaffedRow key={row.item.featureId} row={row} busy={staffingId === row.item.featureId} onStaff={staffPlan} onOpen={openUnstaffed} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Center — transcript + pending-question banner + composer. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedAgent ? (
          <>
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-ink-border dark:bg-panel">
              <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{selectedAgent.name}</span>
              <StatusChip status={selectedAgent.status} />
              {selectedAgent.branch && <span className="truncate font-mono text-[11px] text-gray-400">{shortBranch(selectedAgent.branch)}</span>}
              {/* Per-plan progress in the detail header (§6c). */}
              {selectedPlanItem && (
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-gray-400" title={selectedPlanItem.title}>
                  <FolderGit2 className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                  {selectedPlanItem.title}
                  {selectedPlanItem.progress && selectedPlanItem.progress.total > 0 && (
                    <span className="tabular-nums">· {selectedPlanItem.progress.done}/{selectedPlanItem.progress.total}</span>
                  )}
                </span>
              )}
              <span className="ml-auto"><Kbd keys="]" label="next tab" /></span>
            </div>
            <PendingBanner agent={selectedAgent} onAnswer={(requestId, value) => sendAnswer(selectedAgent.id, requestId, value)} />
            <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-3 dark:bg-ink md:p-4">
              <div className="space-y-4">
                <TranscriptTimeline
                  entries={transcriptEntries}
                  messages={[]}
                  agent={selectedAgent}
                  diffs={selectedDiffs}
                  expanded={workExpanded}
                  onToggle={() => setWorkExpanded((v) => !v)}
                />
              </div>
            </div>
            <Composer
              tasks={tasks}
              suggestionChips={suggestionChips}
              isLoading={false}
              isStopShown={isStopShown}
              stopPending={stopPending}
              onStop={handleStop}
              onSend={handleSend}
              selectedModel={selectedAgent.model ?? ''}
              modelOptions={modelOptions}
              onModelChange={handleModelChange}
              agent={selectedAgent}
              onToast={showToast}
              placeholder={pendingForSelected?.placeholder ?? (pendingForSelected ? 'Type your reply to unblock this agent…' : undefined)}
              focusKey={pendingForSelected?.id}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-gray-400">
            <LayoutPanelLeft className="h-8 w-8" aria-hidden="true" />
            <p className="text-sm">No agent selected — the fleet is empty.</p>
          </div>
        )}
      </div>

      <LandRail agent={selectedAgent} diffs={selectedDiffs} showToast={showToast} />
    </div>
    </PageContextScope>
  );
};
