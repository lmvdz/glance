/**
 * WorkspaceCockpit — reference C ("Workspace cockpit", 213251 — Conductor-style macOS app;
 * plans/orchestration/UI-REFERENCES.md). One screen per agent: roster to pick a unit, the
 * agent's live transcript + composer to steer it, and — glance's actual crown jewel, per
 * memory/PR #67 — the land/PR rail finally given real estate: landReady, the independent
 * validator's verdict + confidence, and a one-tap Land, none of which had a home before this.
 *
 * Every panel below is commented with the human decision it exists to serve (the project's
 * "UI value rule" — see UI-REFERENCES.md's closing constraint note).
 *
 * Reuses rather than forks: TranscriptTimeline + Composer (chat/) for the center pane —
 * these already implement the reference's "collapsible tool-call groups" — and
 * AgentLandControls + validationBadge/confidenceBadge (agent-badges.ts, AgentMetaBar.tsx) for
 * the land rail, so the verify/land logic (force-land, proof-gate toasts) isn't duplicated.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitMerge, LayoutPanelLeft, Terminal as TerminalIcon } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { AgentLandControls } from './chat/AgentMetaBar';
import { validationBadge, confidenceBadge, prStateBadgeLabel } from '../lib/agent-badges';
import { canLand, interruptCommand, interruptibleAgents, setModelCommand } from '../lib/agent-control';
import { apiJson } from '../lib/api';
import { useAgentDiffs } from '../hooks/useAgentDiffs';
import { aggregateDiffCounts, countDiffLines } from '../lib/diff-stat';
import { TranscriptTimeline, agentIsRunning, transcriptIsRunning } from './chat/TranscriptTimeline';
import { Composer, type ModelOption } from './chat/Composer';
import { deriveSuggestionChips } from './AssistantChat';
import { StatusChip, Kbd, MonoLabel, PanelSection, DiffStat } from './kit';
import type { AgentDTO } from '../lib/dto';

const EMPTY_TRANSCRIPT: import('../lib/dto').TranscriptEntry[] = [];

function shortBranch(branch?: string): string {
  return branch ? branch.replace(/^squad\//, '') : '';
}

/**
 * Left rail — the roster. Human decision it serves: "which unit do I look at next", the same
 * question every reference screen's left column answers. Adds the reference's diff-stat chip
 * (`+N -M`) and the shared StatusChip to rows that today only show a colored dot.
 */
const RosterRow: React.FC<{
  agent: AgentDTO;
  selected: boolean;
  diffCounts: { added: number; removed: number };
  onSelect: () => void;
}> = ({ agent, selected, diffCounts, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    aria-current={selected ? 'true' : undefined}
    className={`flex min-h-12 w-full flex-col items-start gap-1 border-b border-gray-100 px-3 py-2 text-left transition-colors dark:border-gray-900 ${
      selected ? 'bg-[color:var(--wf-accent-soft)]' : 'hover:bg-gray-50 dark:hover:bg-gray-900/60'
    }`}
  >
    <div className="flex w-full items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">{agent.name}</span>
      <StatusChip status={agent.status} />
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
  </button>
);

/**
 * Right rail — the PR/land panel. Human decision it serves: "can I trust this enough to land
 * it, right now, in one tap" — the validator verdict + confidence were shipped on the wire in
 * Epic 3 (PR #67) but had rendered in zero components until this screen. `AgentLandControls`
 * carries the actual verify/land network calls (force-land included); this panel is presentation
 * + the file-level Changes list the reference's PR rail shows alongside the Merge button.
 */
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
    <div className="flex h-full w-80 flex-shrink-0 flex-col gap-2 overflow-y-auto border-l border-gray-200 bg-gray-50/60 p-2 dark:border-gray-800 dark:bg-gray-950/60">
      <PanelSection
        title="Land"
        right={agent?.prState ? <StatusChip status={agent.prState} /> : agent?.landReady ? <StatusChip status="done" /> : null}
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

      {/*
       * Terminal tab — DELIBERATELY DEFERRED. The reference's right-rail Run/Terminal tab wraps a
       * real PTY cwd'd in the worktree; glance has no PTY backend today. Rather than silently drop
       * the affordance (which would make the layout diverge from the reference for no stated
       * reason), this stub names the gap so it's a visible, sanctioned deferral, not a missed spot.
       */}
      <PanelSection title="Run" bodyClassName="p-0">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-[11px] dark:border-gray-900">
          <span className="rounded bg-[color:var(--wf-accent-soft)] px-1.5 py-0.5 font-semibold text-[color:var(--wf-accent)]">Transcript</span>
          <button type="button" disabled aria-disabled="true" className="ml-auto flex cursor-not-allowed items-center gap-1 text-gray-400 dark:text-gray-600" title="No PTY backend exists yet — deliberately deferred">
            <TerminalIcon className="h-3 w-3" aria-hidden="true" />
            Terminal (soon)
          </button>
        </div>
      </PanelSection>
    </div>
  );
};

/**
 * WorkspaceCockpit — the composed screen: roster · transcript+composer · land rail.
 */
export const WorkspaceCockpit: React.FC = () => {
  const { agents, tasks, transcripts, sendConsoleCommand, subscribeConsole, showToast } = useTaskContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ label: 'omp default', value: '' }]);
  const [stopPending, setStopPending] = useState(false);

  const roster = useMemo(() => [...agents].sort((a, b) => b.lastActivity - a.lastActivity), [agents]);
  const selectedAgent = roster.find((a) => a.id === selectedId) ?? roster[0];

  // Keep selection valid as the roster changes (agent removed/landed/etc.).
  useEffect(() => {
    if (!selectedId && roster[0]) setSelectedId(roster[0].id);
    else if (selectedId && !roster.some((a) => a.id === selectedId)) setSelectedId(roster[0]?.id ?? null);
  }, [roster, selectedId]);

  useEffect(() => {
    if (selectedAgent) subscribeConsole(selectedAgent.id);
  }, [selectedAgent?.id, subscribeConsole]);

  useEffect(() => {
    void apiJson<{ models?: ModelOption[] }>('/api/models')
      .then((data) => { if (data.models?.length) setModelOptions(data.models); })
      .catch(() => undefined);
  }, []);

  // Keyboard hints made real: Up/Down moves the roster selection without a mouse — the
  // reference treats keyboard hints as first-class chrome, so this backs the hint with a
  // working binding rather than decorating an inert chip.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (roster.length === 0) return;
      e.preventDefault();
      const index = roster.findIndex((a) => a.id === selectedAgent?.id);
      const next = e.key === 'ArrowDown' ? Math.min(roster.length - 1, index + 1) : Math.max(0, index - 1);
      setSelectedId(roster[next]?.id ?? null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [roster, selectedAgent?.id]);

  const diffSignals = useMemo(
    () => roster.map((a) => ({ id: a.id, messageCount: a.messageCount, status: a.status, landReady: a.landReady, prState: a.prState })),
    [roster],
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

  const handleSend = (text: string) => {
    if (!selectedAgent || !text.trim()) return;
    sendConsoleCommand({ type: 'prompt', id: selectedAgent.id, message: text });
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

  return (
    <div className="flex h-full min-h-0 w-full">
      {/*
       * Left rail — roster. Human decision: which unit do I look at next. (See RosterRow doc.)
       */}
      <div className="flex h-full w-64 flex-shrink-0 flex-col border-r border-gray-200 dark:border-gray-800">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <span className="flex items-center gap-1.5">
            <LayoutPanelLeft className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
            <MonoLabel>Roster</MonoLabel>
          </span>
          <Kbd keys="↑↓" label="select" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {roster.length === 0 ? (
            <div className="p-4 text-[12px] text-gray-400">No agents in the fleet right now.</div>
          ) : (
            roster.map((agent) => (
              <RosterRow
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedAgent?.id}
                diffCounts={aggregateDiffCounts(diffsById.get(agent.id) ?? [])}
                onSelect={() => setSelectedId(agent.id)}
              />
            ))
          )}
        </div>
      </div>

      {/*
       * Center — transcript + composer. Human decision: what is this agent doing/did, and do I
       * need to steer it right now. Reuses TranscriptTimeline (collapsible tool-call groups) and
       * Composer (send/stop/model-picker) verbatim rather than forking a second transcript view.
       */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedAgent ? (
          <>
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-800 dark:bg-gray-950">
              <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{selectedAgent.name}</span>
              <StatusChip status={selectedAgent.status} />
              {selectedAgent.branch && <span className="truncate font-mono text-[11px] text-gray-400">{shortBranch(selectedAgent.branch)}</span>}
              <span className="ml-auto"><Kbd keys="]" label="next tab" /></span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 p-3 dark:bg-gray-950 md:p-4">
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
  );
};
