import React, { useState, useEffect } from 'react';
import { Sparkles, ChevronRight, Clock3 } from 'lucide-react';
import { GateWidget } from './GateWidget';
import { DiffReviewPanel, type AgentFileDiff } from './DiffReviewPanel';
import { SettledMarkdown } from './SettledMarkdown';
import { ToolCallGroup, ToolCallRow, fmtDuration, groupToolRuns, toolView } from './ToolCallGroup';
import type { AgentDTO, TranscriptEntry } from '../../lib/dto';

// Moved from AssistantChat.tsx (concern 09 — monolith split): `TranscriptEntryView`
// and `TranscriptTimeline` move together as one module (they're each other's only
// non-trivial consumer), along with the private helpers that exist solely to feed
// them. `transcriptIsRunning`/`agentIsRunning` are re-exported — they're also read
// by `AssistantChat.tsx`'s own state and by `ChatMessagesViewport` — so there is
// one definition, imported forward (AssistantChat.tsx -> chat/TranscriptTimeline.tsx)
// rather than a `chat/ -> ../AssistantChat` cycle.

const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
const EMPTY_DIFFS: AgentFileDiff[] = [];

const entryAction = (entry?: TranscriptEntry): string => {
  if (!entry) return 'Preparing';
  if (entry.kind === 'thinking') return 'Thinking';
  if (entry.kind === 'tool') return toolView(entry).title;
  if (entry.kind === 'assistant') return entry.status === 'running' ? 'Writing response' : 'Responded';
  if (entry.kind === 'system') return entry.text.replace(/^▸\s*/, '') || 'Updating run';
  return 'Queued prompt';
};

export const transcriptIsRunning = (entries: TranscriptEntry[]) => entries.some((entry) => entry.status === 'running');

/** Human sender name for the `aria-label` on each entry's `<article>` wrapper. */
const transcriptEntrySender = (entry: TranscriptEntry): string => {
  switch (entry.kind) {
    case 'user': return 'you';
    case 'assistant': return 'glance';
    case 'thinking': return 'glance (thinking)';
    case 'tool': return (entry.tool?.name ?? 'tool').replace(/_/g, ' ');
    case 'system': return 'system';
    default: return entry.kind;
  }
};

export const agentIsRunning = (agent?: AgentDTO) => agent?.status === 'working' || agent?.status === 'starting';

const transcriptStart = (entries: TranscriptEntry[], messages: { timestamp: number }[], agent?: AgentDTO) => agent?.startedAt ?? entries[0]?.ts ?? messages[0]?.timestamp ?? Date.now();

const transcriptEnd = (entries: TranscriptEntry[], now: number, agent?: AgentDTO) => (
  agentIsRunning(agent) || transcriptIsRunning(entries)
    ? now
    : agent?.receipt?.durationMs && agent?.startedAt
      ? agent.startedAt + agent.receipt.durationMs
      : entries.at(-1)?.ts ?? now
);

// Mapped pre-agent messages (`messageToTranscriptEntry` in AssistantChat.tsx, ids
// stamped `msg:<role>:<timestamp>`) are a synthetic prologue prepended to the merged
// render list — the session's welcome text / chit-chat that predates the agent
// transcript entirely. They must never be folded into the collapsible "work" section,
// and (since they usually start with an assistant-kind welcome) they must not be
// allowed to poison `firstWorkIndex` into 0 for the *real* transcript that follows —
// that used to fold the operator's very first sent message into the collapsed work
// section and hide it the instant the run finished (concern 10 fix).
const isPrologueEntry = (entry: TranscriptEntry) => !!entry.id?.startsWith('msg:');

const splitTranscriptEntries = (entries: TranscriptEntry[]) => {
  const visibleEntries = entries.filter((entry) => entry.text.trim());
  let prologueEnd = 0;
  while (prologueEnd < visibleEntries.length && isPrologueEntry(visibleEntries[prologueEnd])) prologueEnd++;
  const prologueEntries = visibleEntries.slice(0, prologueEnd);
  const rest = visibleEntries.slice(prologueEnd);
  const firstWorkIndex = rest.findIndex((entry) => entry.kind !== 'user');
  if (firstWorkIndex < 0) return { prologueEntries, promptEntries: rest, workEntries: EMPTY_TRANSCRIPT, finalEntry: undefined };
  const promptEntries = rest.slice(0, firstWorkIndex);
  const workEntries = rest.slice(firstWorkIndex);
  const finalEntry = [...workEntries].reverse().find((entry) => entry.kind === 'assistant' && entry.status !== 'running');
  return { prologueEntries, promptEntries, workEntries, finalEntry };
};

export const runStatusLabel = (running: boolean, elapsedMs?: number) => `${running ? 'Working' : 'Worked'} for ${fmtDuration(elapsedMs ?? 0)}`;

export const RunStatusHeader = ({
  running,
  elapsedMs,
  action,
  expanded,
  onToggle,
}: {
  running: boolean;
  elapsedMs?: number;
  action: string;
  expanded: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    onClick={onToggle}
    className="flex min-h-9 w-full items-center gap-2 border-t border-gray-200 pt-3 text-left text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
    aria-expanded={expanded}
  >
    <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
    <Clock3 className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
    <span className="flex-shrink-0">{runStatusLabel(running, elapsedMs)}</span>
    {running && <span className="min-w-0 truncate shimmer">{action}</span>}
  </button>
);

// Ticks its own clock (only while `running`) so a 1s re-render is scoped to
// this leaf instead of the whole transcript panel.
const ElapsedClock = ({
  start,
  end,
  running,
  render,
}: {
  start: number;
  end: number;
  running: boolean;
  render: (elapsedMs: number) => React.ReactElement;
}) => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return render((running ? now : end) - start);
};

export const TranscriptTimeline = ({
  entries,
  trailingEntries = EMPTY_TRANSCRIPT,
  messages,
  agent,
  diffs = EMPTY_DIFFS,
  expanded,
  onToggle,
  onAnswer,
  renderAfterFinal,
}: {
  entries: TranscriptEntry[];
  /** Uncovered fresh/failed sends plus any still-in-flight pendingSends (review finding 2):
   *  rendered in an always-visible section after the fold/final-answer, never folded, and
   *  never fed into `entries` — a running pendingSend here must not make the run below look
   *  like it's still in progress, which used to swallow the previous final answer. */
  trailingEntries?: TranscriptEntry[];
  messages: { timestamp: number }[];
  agent?: AgentDTO;
  diffs?: AgentFileDiff[];
  expanded: boolean;
  onToggle: () => void;
  onAnswer?: (requestId: string, value: string) => void;
  /** Feature 2 D3: called with the full ordered `entries` array plus the run's settled
   *  `finalEntry` once a run has stopped (never while `running`) — lets the caller decide whether
   *  to surface a "Spawn a unit to build this" proposal card under THIS reply, without
   *  `TranscriptTimeline` itself knowing anything about spawn/execution-loop semantics (it stays a
   *  generic transcript renderer; `AssistantChat` + `spawnProposal.ts` own that decision). */
  renderAfterFinal?: (entries: TranscriptEntry[], finalEntry: TranscriptEntry) => React.ReactNode;
}) => {
  const { prologueEntries, promptEntries, workEntries, finalEntry } = splitTranscriptEntries(entries);
  // Deliberately scoped to `entries` (the real transcript, plus its prologue) — never
  // `trailingEntries` — so a pendingSend showing `status:'running'` can't flip this true and
  // fold away the previous finalEntry (review finding 2).
  const running = agentIsRunning(agent) || transcriptIsRunning(entries);
  const visibleTrailingEntries = trailingEntries.filter((entry) => entry.text.trim());
  const start = transcriptStart(entries, messages, agent);
  const end = transcriptEnd(entries, Date.now(), agent);
  const latestWork = [...workEntries].reverse().find((entry) => entry.kind !== 'assistant' || entry.status === 'running') ?? workEntries.at(-1);
  const hiddenWorkEntries = !running && finalEntry ? workEntries.filter((entry) => entry !== finalEntry) : workEntries;

  const renderEntry = (entry: TranscriptEntry) => {
    const gateRequest =
      entry.kind === 'system' && entry.pending?.action === 'created' && agent && onAnswer
        ? agent.pending.find((p) => p.id === entry.pending!.requestId)
        : undefined;
    return (
      <article aria-label={`Message from ${transcriptEntrySender(entry)}`} data-kind={entry.kind} data-status={entry.status ?? ''}>
        <TranscriptEntryView entry={entry} />
        {gateRequest && onAnswer && (
          <GateWidget request={gateRequest} onAnswer={(value) => onAnswer(gateRequest.id, value)} />
        )}
      </article>
    );
  };

  // Consecutive kind:'tool' runs collapse to one ToolCallGroup (latest + "N
  // previous steps") instead of stacking every call — the actual source of
  // transcript scroll bloat on long runs (concern 05). Singleton runs pass
  // through `renderEntry` unchanged.
  const renderEntries = (list: TranscriptEntry[]) => groupToolRuns(list).map((item) => {
    if (item.type === 'group') {
      const first = item.entries[0];
      const key = first.id ?? `${first.ts}:group:${item.entries.length}`;
      const latestStatus = item.entries[item.entries.length - 1]?.status ?? '';
      return (
        <article key={key} aria-label={`${item.entries.length} tool calls`} data-kind="tool" data-status={latestStatus}>
          <ToolCallGroup entries={item.entries} />
        </article>
      );
    }
    const entry = item.entry;
    return (
      <React.Fragment key={entry.id ?? `${entry.ts}:${entry.kind}:${entry.text}`}>
        {renderEntry(entry)}
      </React.Fragment>
    );
  });

  return (
    <>
      {renderEntries(prologueEntries)}
      {renderEntries(promptEntries)}
      <ElapsedClock
        start={start}
        end={end}
        running={running}
        render={(elapsedMs) => (
          <RunStatusHeader running={running} elapsedMs={elapsedMs} action={entryAction(latestWork)} expanded={expanded} onToggle={onToggle} />
        )}
      />
      {expanded && renderEntries(hiddenWorkEntries)}
      {!running && finalEntry && (
        <div className="space-y-3">
          {renderEntry(finalEntry)}
          <DiffReviewPanel diffs={diffs} />
          {renderAfterFinal?.(entries, finalEntry)}
        </div>
      )}
      {running && <DiffReviewPanel diffs={diffs} />}
      {visibleTrailingEntries.length > 0 && (
        <div className="space-y-3" data-trailing-section>
          {renderEntries(visibleTrailingEntries)}
        </div>
      )}
    </>
  );
};

/** Best-effort clipboard copy for the "not delivered" bubble's restore affordance. `Composer`
 *  owns its `input` state privately (not lifted to a prop `AssistantChat` could set), so
 *  copy-to-clipboard is the clean route here rather than reaching into another component's
 *  internals — see review finding 2's "Restore to composer" note. */
const copyToClipboard = (text: string) => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
  }
};

export const TranscriptEntryView = React.memo(({ entry }: { entry: TranscriptEntry }) => {
  if (entry.kind === 'user') {
    // The operator's bare typed text, when the server captured one — `text` stays the
    // durable, context-augmented record the agent actually received (review finding 4).
    const shown = entry.displayText ?? entry.text;
    const undelivered = entry.status === 'error';
    return (
      <div data-chat-message className="flex flex-col w-full items-end">
        <div className="flex flex-col items-end gap-1 max-w-[88%]">
          <div
            className={`rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${
              undelivered
                ? 'border border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
                : 'bg-gray-200 text-gray-900 dark:bg-gray-900 dark:text-gray-100'
            }`}
          >
            {shown}
          </div>
          {undelivered && (
            <div className="flex items-center gap-2 px-1">
              <span className="text-[10px] font-medium text-red-600 dark:text-red-400">Not delivered</span>
              <button
                type="button"
                onClick={() => copyToClipboard(shown)}
                className="text-[10px] font-medium text-red-600 underline decoration-red-300 hover:text-red-700 dark:text-red-400 dark:decoration-red-800"
              >
                Copy text
              </button>
            </div>
          )}
          <span className="text-[10px] text-gray-400 dark:text-gray-500 px-1">
            {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') {
    // Workflow stage markers are progress dividers, not real tool calls.
    if (entry.format === 'stage') {
      const label = entry.text.replace(/^[▸►]\s*stage:\s*/i, '');
      return (
        <div data-chat-message className="flex items-center gap-2 py-1.5 text-[11px] text-gray-400 dark:text-gray-500">
          <div className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
          <span className="font-medium uppercase tracking-wider">{label}</span>
          <div className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
        </div>
      );
    }
    // Single tool entry (run length 1) — a run of >1 renders via ToolCallGroup
    // in TranscriptTimeline instead. Row markup itself lives in ToolCallRow
    // (moved, not duplicated — concern 05) so both paths share one renderer.
    return <ToolCallRow entry={entry} />;
  }

  if (entry.kind === 'thinking') {
    const running = entry.status === 'running';
    return (
      <details data-chat-message open={running} className="group rounded-md">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-900">
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 transition-transform group-open:rotate-90" aria-hidden />
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />
          <span className={`font-medium uppercase tracking-wide ${running ? 'shimmer' : 'text-gray-700 dark:text-gray-300'}`}>Thinking</span>
          <span className="text-gray-400 dark:text-gray-600">{running ? 'streaming' : 'folded'}</span>
        </summary>
        <div className="ml-6 mt-1 border-l border-gray-200 pl-3 text-xs leading-relaxed text-gray-600 dark:border-gray-800 dark:text-gray-400 whitespace-pre-wrap">
          {entry.text}
        </div>
      </details>
    );
  }

  if (entry.kind === 'system') {
    return (
      <div data-chat-message className="rounded-md bg-gray-100 px-2 py-1.5 text-[11px] font-mono leading-relaxed text-gray-600 dark:bg-gray-900 dark:text-gray-400 whitespace-pre-wrap">
        {entry.text}
      </div>
    );
  }

  return (
    <div data-chat-message className="w-full text-gray-800 dark:text-gray-300">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-gray-500">
        {entry.kind === 'assistant' ? 'glance' : entry.kind} <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span> {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {entry.status === 'running' && <span className="shimmer text-[10px]">streaming</span>}
      </div>
      <div className="markdown-body prose dark:prose-invert prose-sm max-w-none text-gray-800 dark:text-gray-300 prose-headings:text-sm prose-headings:font-semibold prose-headings:mb-1 prose-headings:mt-2">
        <SettledMarkdown text={entry.text} status={entry.status} />
      </div>
    </div>
  );
});
