import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Plus, Paperclip, X, Trash2, Maximize2, Minimize2, Download, ArrowLeft, MessageSquare } from 'lucide-react';
import { SettledMarkdown } from './chat/SettledMarkdown';
import { ScrollToLatestPill } from './chat/ScrollToLatestPill';
import { AgentMetaBar, AgentLandControls } from './chat/AgentMetaBar';
import { TodoPanel } from './chat/TodoPanel';
import { DiffReviewPanel, type AgentFileDiff } from './chat/DiffReviewPanel';
import { Composer, type ModelOption, type SuggestionChip } from './chat/Composer';
import { TranscriptTimeline, agentIsRunning, transcriptIsRunning } from './chat/TranscriptTimeline';
import { toolView } from './chat/ToolCallGroup';
import { SpawnProposalCard } from './chat/SpawnProposalCard';
import { SpawnConfirmSheet } from './chat/SpawnConfirmSheet';
import { SpawnStatusCard } from './chat/SpawnStatusCard';
import { useChatStreamScroll } from '../hooks/chat/useChatStreamScroll';
import { useChatNewMessages } from '../hooks/chat/useChatNewMessages';
import { useTaskContext } from '../context/TaskContext';
import { usePageContext } from '../context/PageContext';
import { serializePageContextForPrompt } from '../lib/pageContextDerive';
import { apiJson, jsonInit } from '../lib/api';
import { answerCommand, interruptCommand, interruptibleAgents } from '../lib/agent-control';
import { buildPromptCommand, ensureConsoleAgent } from '../lib/chat/sendCore';
import { spawnProposalFor, type SpawnedUnitRecord, type SpawnProposal } from '../lib/spawnProposal';
import type { AgentDTO, TranscriptEntry } from '../lib/dto';
import type { Task } from '../types';

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  /** Stamped on a user turn at send time (fix, review finding 1) so render-time coverage
   *  dedupe (`partitionSessionMessages`) can match this durable copy against the transcript
   *  entry the server echoes back with the same id, or against the ephemeral `pendingSend`
   *  still showing it live — additive field, tolerated by `normalizeAssistantSessions`. */
  clientTurnId?: string;
  /** Set by the send-timeout/catch path when a turn never reached (or never echoed from) the
   *  server. Survives reload (unlike `pendingSends`, which is render state only) so a failed
   *  send still renders with error styling after a refresh. */
  undelivered?: boolean;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  metadata?: {
    status?: 'waiting' | 'active' | 'autonomous' | 'completed';
    tasksDiscussed?: string[];
    stage?: string;
    agentId?: string;
  };
  /** Feature 2 D3 LINK-BACK: every unit confirmed-and-spawned from this thread, in spawn order.
   *  Persists with the rest of `Session` (same `localStorage` write below) so the thread stays the
   *  durable "I asked → here's the PR" record across a reload — only the tiny record (id/agentId/
   *  createdAt/prompt) is stored here; live status is always re-read from `agents` (see
   *  `spawnCardStatus`'s doc for why nothing about the unit's current state is cached). */
  spawnedUnits?: SpawnedUnitRecord[];
}

const CHAT_WIDTH_KEY = 'omp.assistantChat.width';
const CHAT_MIN_WIDTH = 320;
const CHAT_DEFAULT_WIDTH = 440;
const CHAT_MAX_WIDTH = 680;
const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const CHAT_SESSIONS_KEY = 'assistant-chat-sessions';
const CHAT_WELCOME_MESSAGE = "Ask me anything about the current fleet, or tell me what to do. I’ll keep this as a chat unless you explicitly ask me to start work.";

const createInitialSession = (now = Date.now()): Session => ({
  id: 'default',
  title: 'Initial conversation',
  metadata: {
    status: 'active',
    tasksDiscussed: [],
    stage: 'Planning'
  },
  messages: [
    { role: 'model', text: CHAT_WELCOME_MESSAGE, timestamp: now }
  ],
  updatedAt: now
});

const isSession = (value: unknown): value is Session => {
  const rec = value && typeof value === 'object' ? value as Partial<Session> : {};
  return typeof rec.id === 'string' && typeof rec.title === 'string' && Array.isArray(rec.messages) && typeof rec.updatedAt === 'number';
};

/** Old localStorage blobs may carry a `reaction` field on messages from the (now removed)
 *  thumbs up/down UI. Strip it so it doesn't ride forward into freshly re-persisted state. */
const stripLegacyReaction = (message: Message): Message => {
  if (!message || typeof message !== 'object' || !('reaction' in message)) return message;
  const { reaction: _reaction, ...rest } = message as Message & { reaction?: unknown };
  return rest as Message;
};

// A prior revision of this file destructively dropped every role:'user' message from
// agent-backed sessions here (on the theory the replayed server transcript was always a
// complete duplicate). It wasn't: the server transcript ring is 800-entries-capped and an
// agent record can go dead/evicted, so for those sessions the localStorage copy was the
// ONLY copy — the migration was silent, permanent data loss (review finding 1). There is
// no load-time migration anymore. `handleSend` writes the typed turn into `session.messages`
// AND the replayed transcript keeps growing; render-time coverage dedupe
// (`partitionSessionMessages`, used by `buildTranscriptRenderEntries`) suppresses whichever
// copy is redundant instead of one of them being deleted outright.

export function normalizeAssistantSessions(value: unknown, now = Date.now()): Session[] {
  if (!Array.isArray(value)) return [createInitialSession(now)];
  const sessions = value
    .filter(isSession)
    .map((session) => ({ ...session, messages: session.messages.map(stripLegacyReaction) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions.length ? sessions : [createInitialSession(now)];
}

function readInitialChatState(): { sessions: Session[]; activeSessionId: string | null } {
  if (typeof window === 'undefined') {
    const sessions = normalizeAssistantSessions(null);
    return { sessions, activeSessionId: sessions[0]?.id ?? null };
  }
  const saved = window.localStorage.getItem(CHAT_SESSIONS_KEY);
  let parsed: unknown = null;
  if (saved) {
    try {
      parsed = JSON.parse(saved);
    } catch {
      parsed = null;
    }
  }
  const sessions = normalizeAssistantSessions(parsed);
  return { sessions, activeSessionId: sessions[0]?.id ?? null };
}

const storedChatWidth = () => {
  if (typeof window === 'undefined') return CHAT_DEFAULT_WIDTH;
  const n = Number(window.localStorage.getItem(CHAT_WIDTH_KEY));
  return Number.isFinite(n) ? clampNumber(n, CHAT_MIN_WIDTH, CHAT_MAX_WIDTH) : CHAT_DEFAULT_WIDTH;
};

export const chatWidthFromClientX = (panelRight: number, clientX: number) => clampNumber(panelRight - clientX, CHAT_MIN_WIDTH, CHAT_MAX_WIDTH);

const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
const EMPTY_DIFFS: AgentFileDiff[] = [];
const EMPTY_MESSAGES: { timestamp: number }[] = [];
const EMPTY_SPAWNED_UNITS: SpawnedUnitRecord[] = [];
const EMPTY_AGENTS: AgentDTO[] = [];
const PENDING_SEND_TIMEOUT_MS = 15_000;

const transcriptDownloadText = (entry: TranscriptEntry) => {
  const label = entry.kind === 'user' ? 'You' : entry.kind === 'assistant' ? 'Assistant' : entry.kind.toUpperCase();
  if (entry.kind !== 'tool') {
    // Operators see/export what they typed, not the context-augmented `text` the agent
    // actually received (that stays the durable audit record) — review finding 4.
    const text = entry.kind === 'user' ? (entry.displayText ?? entry.text) : entry.text;
    return `[${new Date(entry.ts).toLocaleString()}] ${label}:\n${text}`;
  }
  const view = toolView(entry);
  return `[${new Date(entry.ts).toLocaleString()}] TOOL:\n${view.title}\n${view.output || ''}${view.stderr ? `\nSTDERR:\n${view.stderr}` : ''}`;
};

const uniqueSuggestions = (items: SuggestionChip[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
};

export function deriveSuggestionChips(input: { messages: Message[]; transcriptEntries: TranscriptEntry[]; selectedTask?: Task; selectedAgent?: AgentDTO; changedFiles?: number | null }): SuggestionChip[] {
  const text = [
    input.selectedTask?.title,
    input.selectedTask?.description,
    input.selectedTask?.category,
    ...input.messages.map((message) => message.text),
    ...input.transcriptEntries.slice(-12).map((entry) => entry.text),
  ].filter(Boolean).join("\n").toLowerCase();
  const out: SuggestionChip[] = [];

  if (/ui|ux|design|designer|interface|visual|layout|frontend|polish|interaction/.test(text)) {
    out.push(
      { label: "Surface UX blind spots", prompt: "Given this UI/UX direction, what user-facing problems am I probably not asking about yet?" },
      { label: "Check states & flows", prompt: "Review the target UI for missing loading, empty, error, disabled, and success states." },
      { label: "Ask the designer agent", prompt: "Bring in the UI/UX designer perspective and propose the next concrete design pass." },
    );
  }
  if (input.selectedAgent?.status === 'input' || /blocked|stuck|waiting|error|failed|crash/.test(text)) {
    out.push(
      { label: "Unblock the run", prompt: "What exactly is blocked, what decision is needed, and what is the safest default?" },
      { label: "Find root cause", prompt: "Trace the failure to the source and suggest the smallest fix with verification." },
    );
  }
  if ((input.changedFiles ?? 0) > 0 || /git|branch|diff|commit|land|merge/.test(text)) {
    out.push({ label: "Review the diff risk", prompt: "Review the current git changes for risky files, missing tests, and landing blockers." });
  }
  if (input.selectedAgent?.contextPct != null && input.selectedAgent.contextPct > 0.7) {
    out.push({ label: "Condense context", prompt: "Summarize the current thread into the durable facts and next actions before context gets tight." });
  }
  if (input.selectedTask) {
    out.push({ label: "Sharpen acceptance", prompt: `For ${input.selectedTask.title}, what acceptance criteria or edge cases are missing?` });
  }

  return uniqueSuggestions([
    ...out,
    { label: "What's being worked on?", prompt: "What's being worked on right now across the fleet, and what needs me?" },
    { label: "Summarize progress", prompt: "Summarize progress" },
    { label: "Prioritize my work", prompt: "Prioritize my work" },
    { label: "List blockers", prompt: "List blocked tasks" },
  ]);
}

export const detectedPlanDirs = (entries: TranscriptEntry[]): string[] => {
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue;
    const haystack = [entry.tool?.argsText, entry.tool?.resultText, entry.text].filter(Boolean).join('\n');
    for (const match of haystack.matchAll(/(?:^|[\\/"'\s])((?:plans)\/[^\/"'\s]+)\//g)) dirs.add(match[1]);
  }
  return [...dirs];
};

// ── Single message model (replay-as-truth + client durability) ─────────────────────────
// Read-time mapper: turns a durable `Message` (pre-agent welcome/chit-chat, a durably
// double-written user turn, or an undelivered-send error notice) into a `TranscriptEntry`
// with a stable synthetic id, so it can render through the one TranscriptTimeline path
// alongside the replayed server transcript. `undelivered` maps to `status:'error'` so it
// picks up the same error styling as a `pendingSend` that timed out.
export const messageToTranscriptEntry = (message: Message): TranscriptEntry => ({
  id: `msg:${message.role}:${message.timestamp}`,
  kind: message.role === 'user' ? 'user' : 'assistant',
  text: message.text,
  ts: message.timestamp,
  format: 'markdown',
  status: message.undelivered ? 'error' : 'ok',
  clientTurnId: message.clientTurnId,
});

/**
 * Coverage dedupe (review finding 1): `handleSend` durably writes every user turn into
 * `session.messages` (fix for the destructive-migration data loss above) in addition to the
 * ephemeral `pendingSend` it also creates. Both, plus the replayed transcript, can carry the
 * *same* turn — this decides, per message, whether it's already visible elsewhere (and should
 * be suppressed) or needs to render on its own, and if so, where:
 *
 *  - Covered by the real transcript (`clientTurnId` match, else exact `displayText ?? text`
 *    match, each transcript entry consumed at most once) → suppressed; it already renders
 *    from `transcriptEntries` itself.
 *  - Covered by a live `pendingSend` (same `clientTurnId`, still `status:'running'`) →
 *    suppressed; the pendingSend already shows it with a live status.
 *  - Otherwise uncovered → positioned by `timestamp` against `windowHeadTs` (the transcript's
 *    first entry, or the current agent's `startedAt` when the transcript hasn't produced
 *    anything yet, or +Infinity when neither exists): older → `prologue` (renders at the top,
 *    chronological — this is how an orphaned send from a dead/evicted agent surfaces, since a
 *    replacement agent's transcript starts *after* it); everything else → `trailing` (renders
 *    after the transcript, newest last — a send still in flight, or one that failed and is
 *    only known via its `undelivered` Message now that the reload wiped `pendingSends`).
 */
export function partitionSessionMessages(
  messages: Message[],
  transcriptEntries: TranscriptEntry[],
  pendingSends: TranscriptEntry[],
  windowHeadTs: number,
): { prologue: TranscriptEntry[]; trailing: TranscriptEntry[] } {
  const transcriptUserEntries = transcriptEntries.filter((entry) => entry.kind === 'user');
  const consumedTranscriptEntries = new Set<TranscriptEntry>();
  const liveTurnIds = new Set(
    pendingSends.filter((entry) => entry.status !== 'error' && entry.clientTurnId).map((entry) => entry.clientTurnId as string),
  );

  const prologue: TranscriptEntry[] = [];
  const trailing: TranscriptEntry[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.clientTurnId) {
        const echoed = transcriptUserEntries.find(
          (entry) => entry.clientTurnId === message.clientTurnId && !consumedTranscriptEntries.has(entry),
        );
        if (echoed) {
          consumedTranscriptEntries.add(echoed);
          continue; // covered by the real transcript
        }
        if (liveTurnIds.has(message.clientTurnId)) continue; // covered by a live pendingSend
      } else {
        // Legacy message with no clientTurnId (pre-fix localStorage blob): fall back to an
        // exact text match against the operator's typed text, consumed oldest-first.
        const matched = transcriptUserEntries.find(
          (entry) => !consumedTranscriptEntries.has(entry) && (entry.displayText ?? entry.text) === message.text,
        );
        if (matched) {
          consumedTranscriptEntries.add(matched);
          continue;
        }
      }
    }
    const entry = messageToTranscriptEntry(message);
    (message.timestamp < windowHeadTs ? prologue : trailing).push(entry);
  }

  return { prologue, trailing };
}

/**
 * Render composition: `entries` is the ordinary TranscriptTimeline content (prologue-mapped
 * messages, then the replayed transcript) — TranscriptTimeline's collapsible-work fold and
 * "is anything running" calculations key off this and only this. `trailingEntries` (uncovered
 * fresh/failed sends, then any still-in-flight `pendingSends`) is a separate always-visible
 * section rendered after the fold/final-answer — it must never be folded, and must never make
 * the fold logic think a run is still in progress (review finding 2).
 */
export function buildTranscriptRenderEntries(
  messages: Message[],
  transcriptEntries: TranscriptEntry[],
  pendingSends: TranscriptEntry[],
  agentStartedAt?: number,
): { entries: TranscriptEntry[]; trailingEntries: TranscriptEntry[] } {
  // Fallback order when there's no transcript to anchor against: the current agent's
  // `startedAt` (an agent exists, just hasn't echoed anything yet — e.g. a send still in
  // flight), else -Infinity (no agent at all for this attempt, e.g. `/api/console` itself
  // failed) so an uncovered message defaults to trailing (a fresh/failed send) rather than
  // prologue (stale content) — the only genuinely ambiguous case, a session with nothing but
  // its pre-agent welcome text, is unaffected either way since there is nothing else to order
  // it against.
  const windowHeadTs = transcriptEntries[0]?.ts ?? agentStartedAt ?? Number.NEGATIVE_INFINITY;
  const { prologue, trailing } = partitionSessionMessages(messages, transcriptEntries, pendingSends, windowHeadTs);
  return {
    entries: [...prologue, ...transcriptEntries],
    trailingEntries: [...trailing, ...pendingSends],
  };
}

/** Drops any pending (optimistic) send whose `clientTurnId` has now arrived as a
 *  `kind==='user'` entry in the real transcript. Restricted to user-kind on purpose:
 *  gate answers also travel as `{ type: 'prompt', clientTurnId: requestId }` (see
 *  `answerCommand`), so their echoed transcript entry also carries a `clientTurnId` —
 *  but it will never equal a prompt-originated pending send's turn id, and matching
 *  only against user-kind entries keeps that distinction explicit rather than incidental. */
export const clearEchoedPendingSends = (pendingSends: TranscriptEntry[], transcriptEntries: TranscriptEntry[]): TranscriptEntry[] => {
  if (!pendingSends.length) return pendingSends;
  const echoedTurnIds = new Set(
    transcriptEntries.filter((entry) => entry.kind === 'user' && entry.clientTurnId).map((entry) => entry.clientTurnId as string),
  );
  if (!echoedTurnIds.size) return pendingSends;
  const next = pendingSends.filter((entry) => !(entry.clientTurnId && echoedTurnIds.has(entry.clientTurnId)));
  return next.length === pendingSends.length ? pendingSends : next;
};

/**
 * The scrollable transcript viewport: locked-to-bottom-by-default, unlocks on
 * upward scroll, surfaces a "jump to latest" pill on new content while
 * unlocked. Owns its own `useChatStreamScroll`/`useChatNewMessages` instances
 * so the parent can key it by session (`AssistantChat` renders
 * `<ChatMessagesViewport key={activeSessionId}>`) — remounting resets lock
 * state and scroll position instead of leaking them across sessions.
 */
export const ChatMessagesViewport = ({
  entries,
  trailingEntries = EMPTY_TRANSCRIPT,
  transcriptEntries = EMPTY_TRANSCRIPT,
  selectedAgent,
  agentDiffs,
  workExpanded,
  onToggleWork,
  onAnswer,
  isLoading,
  renderAfterFinal,
  spawnedUnits = EMPTY_SPAWNED_UNITS,
  agents = EMPTY_AGENTS,
  showToast,
  onViewSpawnedRun,
}: {
  entries: TranscriptEntry[];
  /** Uncovered fresh/failed sends + in-flight pendingSends — always-visible trailing
   *  section, never folded (review finding 2). */
  trailingEntries?: TranscriptEntry[];
  /** The real, replayed server transcript only — used (not `entries`, which may carry a
   *  prologue, and not `trailingEntries`, which may carry a pendingSend) to decide whether
   *  the log region is "busy" in the collapsible-work-fold sense (review finding 2). */
  transcriptEntries?: TranscriptEntry[];
  selectedAgent?: AgentDTO;
  agentDiffs: AgentFileDiff[];
  workExpanded: boolean;
  onToggleWork: () => void;
  onAnswer?: (requestId: string, value: string) => void;
  isLoading: boolean;
  /** Feature 2 D3 — forwarded straight to `TranscriptTimeline` (see its own doc). */
  renderAfterFinal?: (entries: TranscriptEntry[], finalEntry: TranscriptEntry) => React.ReactNode;
  /** Feature 2 D3 LINK-BACK — this session's spawned-unit records, rendered as pinned status cards
   *  after the transcript, oldest first (the durable "I asked → here's the PR" record). */
  spawnedUnits?: SpawnedUnitRecord[];
  agents?: AgentDTO[];
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  onViewSpawnedRun?: (agentId: string) => void;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isLocked, scrollToBottom, scrollIfLocked } = useChatStreamScroll({ scrollRef });
  const { hasNewMessages, dismiss, contentRef } = useChatNewMessages({ isLocked, onResize: scrollIfLocked });
  // Two distinct notions of "busy" (review finding 2): the work-fold's own `running` (computed
  // inside TranscriptTimeline from the real transcript only) decides what stays folded; this
  // aria-busy is a broader, purely-accessibility signal that also goes true while a send is
  // still in flight (isLoading, or a pendingSend with status:'running') even before the
  // transcript has produced anything to be "running" about.
  const pendingInFlight = trailingEntries.some((entry) => entry.status === 'running');
  const anyEntryRunning = transcriptIsRunning(transcriptEntries) || isLoading || pendingInFlight;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={anyEntryRunning}
        tabIndex={0}
        className="h-full overflow-y-auto p-3 md:p-4 scrollbar-custom bg-gray-50 dark:bg-gray-950"
      >
        <div ref={contentRef} className="space-y-4">
          <TranscriptTimeline
            entries={entries}
            trailingEntries={trailingEntries}
            messages={EMPTY_MESSAGES}
            agent={selectedAgent}
            diffs={agentDiffs}
            expanded={workExpanded}
            onToggle={onToggleWork}
            onAnswer={onAnswer}
            renderAfterFinal={renderAfterFinal}
          />
          {spawnedUnits.length > 0 && (
            <div className="space-y-2" data-spawn-status-cards>
              {[...spawnedUnits].sort((a, b) => a.createdAt - b.createdAt).map((record) => (
                <SpawnStatusCard
                  key={record.id}
                  record={record}
                  agent={agents.find((a) => a.id === record.agentId)}
                  showToast={showToast ?? (() => undefined)}
                  onViewRun={() => onViewSpawnedRun?.(record.agentId)}
                />
              ))}
            </div>
          )}
          {isLoading && (
            <div className="flex flex-col w-full items-start text-gray-800 dark:text-gray-300">
              <div className="text-[11px] text-gray-500 dark:text-gray-500 mb-2 flex items-center gap-2">
                glance workflow <span className="w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-600"></span> Starting...
              </div>
              <div className="flex gap-1 items-center h-6">
                <span className="w-2 h-2 bg-amber-500 rounded-full animate-bounce"></span>
                <span className="w-2 h-2 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
                <span className="w-2 h-2 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></span>
              </div>
            </div>
          )}
        </div>
      </div>
      <ScrollToLatestPill
        visible={hasNewMessages && !isLocked}
        onClick={() => {
          scrollToBottom();
          dismiss();
        }}
      />
    </div>
  );
};

export const AssistantChat = ({ onClose }: { onClose: () => void }) => {
  const { agents, features, audit, tasks, selectedTaskId, currentProject, transcripts, sendConsoleCommand, subscribeConsole, openedConsoleAgentId, openConsole, showToast } = useTaskContext();
  // Feature 2 D1/D2: whichever view the operator is actually looking at right now — published by
  // that view's <PageContextScope> (see App.tsx/WorkspaceCockpit.tsx/OmpGraphPanel.tsx). Replaces
  // the old selectedTask-only assembly below with the live page, not just a maybe-selected task.
  const pageContext = usePageContext();
  const [initialChatState] = useState(readInitialChatState);
  const [sessions, setSessions] = useState<Session[]>(initialChatState.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialChatState.activeSessionId);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [todoCollapsed, setTodoCollapsed] = useState(false);
  const [agentDiffs, setAgentDiffs] = useState<AgentFileDiff[] | null>(null);
  const [workExpanded, setWorkExpanded] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ label: 'omp default', value: '' }]);
  const [selectedModel, setSelectedModel] = useState('');
  const [chatWidth, setChatWidth] = useState(storedChatWidth);
  // Feature 2 D3 — the confirmation gate's open/closed state. Non-null renders the
  // SpawnConfirmSheet; setting it back to null is the ONLY way it closes (Cancel, or a
  // successful confirm) — there is no auto-dismiss, no timeout (D3/D5: never auto-spawn).
  const [spawnProposal, setSpawnProposal] = useState<SpawnProposal | null>(null);
  const [pendingSends, setPendingSends] = useState<TranscriptEntry[]>([]);
  const pendingSendTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const promotedPlanDirs = useRef<Set<string>>(new Set());
  const chatPanelRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const messages = activeSession?.messages || [];
  const agentId = activeSession?.metadata?.agentId;
  const selectedAgent = agentId ? agents.find((agent) => agent.id === agentId) : undefined;
  const transcriptEntries = agentId ? (transcripts.get(agentId) ?? EMPTY_TRANSCRIPT) : EMPTY_TRANSCRIPT;
  const todoPhases = selectedAgent?.todoPhases ?? [];
  const sessionPendingSends = activeSessionId ? pendingSends.filter((entry) => entry.id?.startsWith(`pending:${activeSessionId}:`)) : EMPTY_TRANSCRIPT;
  const { entries: mainEntries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, sessionPendingSends, selectedAgent?.startedAt);
  const transcriptRunning = transcriptIsRunning(transcriptEntries);
  const agentRunning = agentIsRunning(selectedAgent) || transcriptRunning || isLoading;
  const isStopShown = !!selectedAgent && interruptibleAgents([selectedAgent]).length > 0;
  const changedFiles = agentDiffs?.length ?? null;
  const selectedTask = tasks.find(t => t.id === selectedTaskId);
  const suggestionChips = deriveSuggestionChips({ messages, transcriptEntries, selectedTask, selectedAgent, changedFiles });
  const currentModelOptions = selectedModel && !modelOptions.some((option) => option.value === selectedModel)
    ? [...modelOptions, { label: selectedModel, value: selectedModel }]
    : modelOptions;

  useEffect(() => {
    if (activeSessionId && !sessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(sessions[0]?.id ?? null);
    }
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (agentId) subscribeConsole(agentId);
  }, [agentId, subscribeConsole]);

  // Clear an optimistic pending send once its clientTurnId echoes back as a real
  // (kind==='user') transcript entry — the send genuinely landed. Gate answers reuse
  // clientTurnId for their own requestId, but only user-kind entries are matched here,
  // and only against clientTurnIds this component itself minted, so an answer never
  // clears an unrelated pending send.
  useEffect(() => {
    setPendingSends((prev) => {
      const next = clearEchoedPendingSends(prev, transcriptEntries);
      if (next === prev) return prev;
      const stillPending = new Set(next.map((entry) => entry.clientTurnId));
      for (const [turnId, timeout] of pendingSendTimeouts.current) {
        if (!stillPending.has(turnId)) {
          clearTimeout(timeout);
          pendingSendTimeouts.current.delete(turnId);
        }
      }
      return next;
    });
  }, [transcriptEntries]);

  useEffect(() => () => {
    for (const timeout of pendingSendTimeouts.current.values()) clearTimeout(timeout);
    pendingSendTimeouts.current.clear();
  }, []);

  // Reset the "stopping…" debounce once the agent actually leaves the running state — the
  // interrupt itself gives no immediate ack, so this pending flag *is* the feedback.
  useEffect(() => {
    if (!isStopShown && stopTimeoutRef.current) {
      clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
      setStopPending(false);
    }
  }, [isStopShown]);

  useEffect(() => () => {
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
  }, []);

  const handleStop = () => {
    if (!agentId || stopPending) return; // debounce, never escalate — no reachable kill from here
    sendConsoleCommand(interruptCommand(agentId));
    setStopPending(true);
    stopTimeoutRef.current = setTimeout(() => setStopPending(false), 8000);
  };

  // When an external "Open console" targets a specific agent, find or create a session for it.
  useEffect(() => {
    if (!openedConsoleAgentId) return;
    const agent = agents.find((a) => a.id === openedConsoleAgentId);
    setSessions((prev) => {
      if (prev.some((s) => s.id === openedConsoleAgentId)) return prev;
      const newSession: Session = {
        id: openedConsoleAgentId,
        title: agent?.name ?? 'Agent console',
        messages: [],
        updatedAt: Date.now(),
        metadata: { agentId: openedConsoleAgentId, status: 'active', stage: 'Console' },
      };
      return [newSession, ...prev];
    });
    setActiveSessionId(openedConsoleAgentId);
  }, [openedConsoleAgentId, agents]);

  useEffect(() => {
    void apiJson<{ models?: ModelOption[] }>('/api/models')
      .then((data) => {
        if (data.models?.length) setModelOptions(data.models);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (selectedAgent?.model) setSelectedModel(selectedAgent.model);
  }, [selectedAgent?.model]);

  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
  }, [chatWidth]);

  useEffect(() => {
    if (!agentId) {
      setAgentDiffs(null);
      return;
    }
    let cancelled = false;
    setAgentDiffs(null);
    void apiJson<AgentFileDiff[]>(`/api/agents/${encodeURIComponent(agentId)}/diff`)
      .then((diffs) => {
        if (!cancelled) setAgentDiffs(diffs);
      })
      .catch(() => {
        if (!cancelled) setAgentDiffs(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, selectedAgent?.messageCount, selectedAgent?.status]);

  useEffect(() => {
    setWorkExpanded(agentRunning);
  }, [agentId, agentRunning]);

  // Titling for a freshly-started "New Chat" session happens inline in `handleSend` (the first
  // send that spins up an agent). Accepts either a replacement array or an updater function —
  // the updater form is required wherever a caller runs after an `await` or inside a `setTimeout`
  // (the send-timeout and catch paths below), since the `messages` closed over at call time may
  // be stale by then.
  const updateSessionMessages = (sessionId: string, next: Message[] | ((messages: Message[]) => Message[])) => {
    setSessions(prev => prev.map(s => (s.id === sessionId
      ? { ...s, messages: typeof next === 'function' ? (next as (messages: Message[]) => Message[])(s.messages) : next, updatedAt: Date.now() }
      : s)));
  };

  useEffect(() => {
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    const repo = currentProject?.id;
    if (!repo) return;
    for (const planDir of detectedPlanDirs(transcriptEntries)) {
      const key = `${repo}:${planDir}`;
      if (promotedPlanDirs.current.has(key)) continue;
      promotedPlanDirs.current.add(key);
      const title = planDir.split('/').pop()?.replace(/[-_]+/g, ' ') || planDir;
      void apiJson('/api/features/from-plan', jsonInit('POST', { repo, planDir, title })).catch(() => promotedPlanDirs.current.delete(key));
    }
  }, [currentProject?.id, transcriptEntries]);

  const createNewSession = () => {
    const newSession: Session = {
      id: Date.now().toString(),
      title: 'New Chat',
      metadata: {
        status: 'active',
        stage: 'Planning'
      },
      messages: [
        { role: 'model', text: "Ask me anything, or explicitly tell me to start work.", timestamp: Date.now() }
      ],
      updatedAt: Date.now()
    };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
  };

  const clearChat = () => {
    if (activeSessionId) {
      updateSessionMessages(activeSessionId, [
        { role: 'model', text: "Ask me anything, or explicitly tell me to start work.", timestamp: Date.now() }
      ]);
    }
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) {
      setActiveSessionId(null);
    }
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    if (selectedAgent && model) sendConsoleCommand({ type: 'set-model', id: selectedAgent.id, model });
  };

  // Declared state-relocation (concern 09 — monolith split): the composer's typed-input state
  // and the `@`-mention trigger-menu now live in `chat/Composer.tsx`, which validates and clears
  // its own input before calling this with a non-empty `textToSend`. Agent creation + prompt-shape
  // assembly now live in `lib/chat/sendCore.ts` (concern 04 — shared with the voice dispatcher);
  // this component keeps only the optimistic pendingSends/clientTurnId machinery and session
  // bookkeeping around those two calls.
  //
  // Single message model (concern 10 — replay-as-truth) + client durability (review finding 1):
  // the server echoes every prompt into the agent's persisted transcript (replayed on every
  // subscribe) — but that ring is 800-entries-capped and an agent record can go dead/evicted, so
  // it is NOT a substitute for a client-side durable copy. A send therefore writes twice: an
  // ephemeral `pendingSend` (instant optimistic UI, cleared the moment its `clientTurnId` echoes
  // back as a real transcript entry) AND a durable `Message` appended to `session.messages`
  // (survives reload; render-time coverage dedupe — `partitionSessionMessages` — suppresses
  // whichever copy is redundant once the real thing shows up).
  const handleSend = async (textToSend: string) => {
    if (!textToSend || isLoading || !activeSessionId) return;
    const sessionId = activeSessionId;

    const clientTurnId = `turn:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const pendingId = `pending:${sessionId}:${clientTurnId}`;
    const sentAt = Date.now();
    setPendingSends((prev) => [...prev, {
      id: pendingId,
      kind: 'user',
      text: textToSend,
      ts: sentAt,
      format: 'markdown',
      status: 'running',
      clientTurnId,
    }]);
    updateSessionMessages(sessionId, (prev) => [...prev, { role: 'user', text: textToSend, timestamp: sentAt, clientTurnId }]);
    pendingSendTimeouts.current.set(clientTurnId, setTimeout(() => {
      // Never echoed back. Hand off from the ephemeral pendingSend to the durable Message's
      // `undelivered` flag instead of leaving an errored pendingSend sitting in the state
      // forever (review finding 2) — the Message survives reload, the pendingSend does not.
      setPendingSends((prev) => prev.filter((entry) => entry.clientTurnId !== clientTurnId));
      updateSessionMessages(sessionId, (prev) => prev.map((m) => (m.clientTurnId === clientTurnId ? { ...m, undelivered: true } : m)));
      pendingSendTimeouts.current.delete(clientTurnId);
    }, PENDING_SEND_TIMEOUT_MS));
    setIsLoading(true);

    try {
      const priorAgentId = activeSession?.metadata?.agentId;
      const nextAgentId = await ensureConsoleAgent(
        { apiJson, subscribeConsole, roster: agents, currentProject, selectedModel },
        sessionId,
        priorAgentId,
      );
      if (nextAgentId !== priorAgentId) {
        setSessions(prev => prev.map(session => session.id === sessionId ? {
          ...session,
          title: session.title === 'New Chat' ? (textToSend.length > 30 ? `${textToSend.slice(0, 30)}...` : textToSend) : session.title,
          metadata: { ...session.metadata, agentId: nextAgentId, status: 'active', stage: 'Chat' },
        } : session));
      }
      const command = buildPromptCommand(
        { agentId: nextAgentId, agents, features, audit, selectedTask, pageContext },
        textToSend,
        { clientTurnId, source: 'composer' },
      );
      sendConsoleCommand(command);
    } catch (error: any) {
      const timeout = pendingSendTimeouts.current.get(clientTurnId);
      if (timeout) {
        clearTimeout(timeout);
        pendingSendTimeouts.current.delete(clientTurnId);
      }
      setPendingSends((prev) => prev.filter((entry) => entry.clientTurnId !== clientTurnId));
      updateSessionMessages(sessionId, (prev) => [
        ...prev.map((m) => (m.clientTurnId === clientTurnId ? { ...m, undelivered: true } : m)),
        { role: 'model', text: `Error: ${error.message || 'Could not reach glance chat'}`, timestamp: Date.now() },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  // Feature 2 D3 — the one place `/api/spawn` is ever called from this feature. `finalPrompt`
  // already carries the operator's edited text, the fenced image reference(s), the serialized page
  // context, and the standard contract line (assembled by SpawnConfirmSheet via
  // `buildSpawnPrompt`) — this function's only job is the POST + the durable link-back write. A
  // thrown error propagates back to the sheet (its own try/catch), which keeps itself open and
  // shows it inline rather than silently discarding the operator's edited prompt.
  const handleConfirmSpawn = async (finalPrompt: string) => {
    const result = await apiJson<{ agent: AgentDTO }>('/api/spawn', jsonInit('POST', { prompt: finalPrompt }));
    if (activeSessionId) {
      const record: SpawnedUnitRecord = { id: `spawn:${Date.now()}:${Math.random().toString(36).slice(2)}`, agentId: result.agent.id, createdAt: Date.now(), prompt: finalPrompt };
      setSessions((prev) => prev.map((session) => (session.id === activeSessionId
        ? { ...session, spawnedUnits: [...(session.spawnedUnits ?? []), record] }
        : session)));
    }
    showToast(`Spawned ${result.agent.name} — tracking it in this thread.`, 'success');
    setSpawnProposal(null);
  };

  // "Target repo" line the confirm sheet shows (D3) — the human-readable name of whichever repo
  // this chat's own /api/console session is scoped to (the same `currentProject?.id` handleSend
  // already sends as `repo`). /api/spawn itself has no repo field (SpawnBodySchema is
  // `{prompt, profileId}` only) — smart-spawn resolves the target from the prompt text + its own
  // cwd/tracked-repo candidates (smart-spawn.ts's `pickRepoHeuristic`), so this label is purely
  // informational, not wired to the request; `buildSpawnPrompt` also folds it into an explicit
  // "Target repo: …" line in the prompt itself to nudge that heuristic toward the repo the operator
  // is actually looking at.
  const spawnRepoLabel = currentProject?.name || currentProject?.id || 'this repo';

  const downloadHistory = () => {
    if (!activeSession) return;
    const content = [...mainEntries, ...trailingEntries].map(transcriptDownloadText).join('\n\n-------------------\n\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-history-${activeSession.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startChatResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = chatPanelRef.current;
    if (!panel) return;
    event.preventDefault();
    const right = panel.getBoundingClientRect().right;
    const update = (clientX: number) => setChatWidth(chatWidthFromClientX(right, clientX));
    update(event.clientX);
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const nudgeChatWidth = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setChatWidth((width) => clampNumber(width + (event.key === 'ArrowLeft' ? 24 : -24), CHAT_MIN_WIDTH, CHAT_MAX_WIDTH));
  };

  const chatShellClass = `relative flex flex-col bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 flex-shrink-0 z-20 transition-colors ${isMaximized ? 'fixed inset-0 w-full z-50' : ''}`;
  const chatShellStyle = isMaximized ? undefined : ({ width: chatWidth } as React.CSSProperties);
  const chatResizeHandle = !isMaximized && (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize assistant chat"
      aria-valuemin={CHAT_MIN_WIDTH}
      aria-valuemax={CHAT_MAX_WIDTH}
      aria-valuenow={chatWidth}
      tabIndex={0}
      onPointerDown={startChatResize}
      onKeyDown={nudgeChatWidth}
      onDoubleClick={() => setChatWidth(CHAT_DEFAULT_WIDTH)}
      className="group absolute inset-y-0 left-0 z-30 hidden w-1 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-amber-500/20 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-amber-400/20 lg:flex"
      title="Drag to resize chat. Double-click to reset."
    >
      <span className="h-10 w-px rounded-full bg-gray-300 transition-colors group-hover:bg-amber-500 dark:bg-gray-700 dark:group-hover:bg-amber-400" aria-hidden="true" />
    </div>
  );


  if (!activeSessionId) {
    return (
      <div ref={chatPanelRef} className={chatShellClass} style={chatShellStyle}>
        {chatResizeHandle}
        <div className="h-10 flex items-center justify-between px-3 flex-shrink-0 text-gray-800 dark:text-gray-200 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-medium">Session History</h3>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setIsMaximized(!isMaximized)} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors" title={isMaximized ? "Minimize" : "Maximize"}>
              {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors" title="Close Chat">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-custom">
          {sessions.length === 0 && (
            <div className="text-center text-sm text-gray-500 py-10">No sessions found</div>
          )}
          {sessions.sort((a,b) => b.updatedAt - a.updatedAt).map(session => (
            <div
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className="flex flex-col p-2.5 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer transition-colors group"
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="font-medium text-sm text-gray-900 dark:text-gray-200 mb-0.5">{session.title}</div>
                  <div className="text-[11px] text-gray-500">{new Date(session.updatedAt).toLocaleDateString()} {new Date(session.updatedAt).toLocaleTimeString()}</div>
                </div>
                <button
                  onClick={(e) => deleteSession(session.id, e)}
                  className="p-1.5 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Metadata Display */}
              <div className="flex flex-wrap gap-2 mt-1">
                {session.metadata?.status && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    session.metadata.status === 'active' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                    session.metadata.status === 'waiting' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                    session.metadata.status === 'autonomous' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' :
                    'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                  }`}>
                    {session.metadata.status === 'active' ? '● Running' :
                     session.metadata.status === 'waiting' ? '○ Waiting for Input' :
                     session.metadata.status === 'autonomous' ? '⚡ Autonomous' :
                     '✓ Completed'}
                  </span>
                )}
                {session.metadata?.stage && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700">
                    Stage: {session.metadata.stage}
                  </span>
                )}
                {session.metadata?.tasksDiscussed && session.metadata.tasksDiscussed.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 flex items-center gap-1">
                    <Paperclip className="w-2.5 h-2.5" /> {session.metadata.tasksDiscussed.length} task(s)
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="p-3 border-t border-gray-200 dark:border-gray-800">
          <button
            onClick={createNewSession}
            className="w-full py-2.5 bg-gray-900 dark:bg-gray-200 text-white dark:text-gray-900 rounded-lg text-sm font-medium hover:bg-black dark:hover:bg-white transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" /> New Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={chatPanelRef} className={chatShellClass} style={chatShellStyle}>
      {chatResizeHandle}
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 flex-shrink-0 text-gray-800 dark:text-gray-200 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <button onClick={() => setActiveSessionId(null)} className="p-1.5 -ml-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors" title="Back to Sessions">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Sparkles className="w-4 h-4 text-amber-500 dark:text-amber-400" />
          <h3 className="text-sm font-medium truncate max-w-[150px]" title={activeSession?.title}>{activeSession?.title || 'glance'}</h3>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={downloadHistory} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors" title="Export Chat">
            <Download className="w-4 h-4" />
          </button>
          <button onClick={clearChat} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors" title="Clear Chat">
            <Trash2 className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-1"></div>
          <button onClick={() => setIsMaximized(!isMaximized)} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors" title={isMaximized ? "Minimize" : "Maximize"}>
            {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors" title="Close Chat">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <AgentMetaBar agent={selectedAgent} changedFiles={changedFiles}>
        <AgentLandControls agent={selectedAgent} showToast={showToast} />
      </AgentMetaBar>

      <TodoPanel phases={todoPhases} collapsed={todoCollapsed} onToggle={() => setTodoCollapsed((value) => !value)} />

      {/* Messages */}
      <ChatMessagesViewport
        key={activeSessionId ?? 'none'}
        entries={mainEntries}
        trailingEntries={trailingEntries}
        transcriptEntries={transcriptEntries}
        selectedAgent={selectedAgent}
        agentDiffs={agentDiffs ?? EMPTY_DIFFS}
        workExpanded={workExpanded}
        onToggleWork={() => setWorkExpanded((value) => !value)}
        onAnswer={selectedAgent ? (requestId, value) => {
          sendConsoleCommand(answerCommand(selectedAgent.id, requestId, value));
          showToast(`Answer sent to ${selectedAgent.name}`, 'success');
        } : undefined}
        isLoading={isLoading}
        renderAfterFinal={(timelineEntries, finalEntry) => {
          const proposal = spawnProposalFor(timelineEntries, finalEntry);
          return proposal ? <SpawnProposalCard onPropose={() => setSpawnProposal(proposal)} /> : null;
        }}
        spawnedUnits={activeSession?.spawnedUnits}
        agents={agents}
        showToast={showToast}
        onViewSpawnedRun={openConsole}
      />

      {spawnProposal && (
        <SpawnConfirmSheet
          promptSeed={spawnProposal.promptSeed}
          imagePaths={spawnProposal.imagePaths}
          pageContextBlock={serializePageContextForPrompt(pageContext)}
          repoLabel={spawnRepoLabel}
          onCancel={() => setSpawnProposal(null)}
          onConfirm={handleConfirmSpawn}
        />
      )}

      {/* Input Area */}
      <Composer
        tasks={tasks}
        suggestionChips={suggestionChips}
        isLoading={isLoading}
        isStopShown={isStopShown}
        stopPending={stopPending}
        onStop={handleStop}
        onSend={handleSend}
        selectedModel={selectedModel}
        modelOptions={currentModelOptions}
        onModelChange={handleModelChange}
        agent={selectedAgent}
      />
    </div>
  );
};
