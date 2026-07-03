import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Plus, Mic, Paperclip, ArrowUp, X, ChevronRight, Copy, Check, Trash2, Maximize2, Minimize2, Download, ThumbsUp, ThumbsDown, ArrowLeft, MessageSquare, Clock3, TerminalSquare, FileText, Send } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeHighlight } from './CodeHighlight';
import { useTaskContext } from '../context/TaskContext';
import { apiFetch, apiJson, jsonInit } from '../lib/api';
import { answerCommand, canLand, landToast, verifyToast, type LandResultDTO, type ProofResultDTO, type ToastTone } from '../lib/agent-control';
import { activeWork, activeWorkDigest } from '../lib/insights';
import { fleetActivityDigest, fleetActivityLines, fleetActivityRollup } from '../lib/fleetActivity';
import type { AgentDTO, PendingRequest, TodoPhaseDTO, TodoStatus, TranscriptEntry } from '../lib/dto';
import type { Task } from '../types';

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  reaction?: 'like' | 'dislike';
}

interface ConsoleStart {
  agentId: string;
}

interface ModelOption {
  label: string;
  value: string;
}

interface AgentFileDiff {
  file: string;
  status?: string;
  diff?: string;
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

export function normalizeAssistantSessions(value: unknown, now = Date.now()): Session[] {
  if (!Array.isArray(value)) return [createInitialSession(now)];
  const sessions = value.filter(isSession).sort((a, b) => b.updatedAt - a.updatedAt);
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

const CodeBlock = ({ inline, className, children, ...props }: any) => {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const isBlock = !inline && match;

  const handleCopy = () => {
    navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isBlock) {
    return <code className={className} {...props}>{children}</code>;
  }

  return (
    <div className="relative group rounded-md overflow-hidden bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 my-4">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800">
        <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">{match[1]}</span>
        <button
          onClick={handleCopy}
          className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors flex items-center gap-1 text-xs"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500 dark:text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="p-4 overflow-x-auto text-sm text-gray-700 dark:text-gray-300">
        <CodeHighlight
          language={match[1]}
          customStyle={{ margin: 0, padding: 0, background: 'transparent' }}
        >
          {String(children).replace(/\n$/, '')}
        </CodeHighlight>
      </div>
    </div>
  );
};

const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
const EMPTY_DIFFS: AgentFileDiff[] = [];

const statusDotClass = (status?: TranscriptEntry['status']) => {
  if (status === 'error') return 'bg-red-500';
  if (status === 'running') return 'bg-blue-500';
  if (status === 'cancelled') return 'bg-amber-500';
  return 'bg-emerald-500';
};
const parseToolJson = (text?: string): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const prettyJson = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const asRecord = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};

const contentText = (value: unknown): string => {
  const rec = asRecord(value);
  if (typeof rec.stdout === 'string') return rec.stdout;
  if (typeof rec.output === 'string') return rec.output;
  if (typeof rec.text === 'string') return rec.text;
  if (Array.isArray(rec.content)) return rec.content.map((item) => asRecord(item).text).filter((text): text is string => typeof text === 'string').join('\n');
  return typeof value === 'string' ? value : '';
};

const toolView = (entry: TranscriptEntry) => {
  const args = parseToolJson(entry.tool?.argsText);
  const partial = parseToolJson(entry.tool?.partialText);
  const result = parseToolJson(entry.tool?.resultText);
  const argRec = asRecord(args);
  const resultRec = asRecord(result);
  const partialRec = asRecord(partial);
  const command = typeof argRec.command === 'string' ? argRec.command : typeof argRec.cmd === 'string' ? argRec.cmd : '';
  const output = contentText(result) || contentText(partial);
  const stderr = typeof resultRec.stderr === 'string' ? resultRec.stderr : typeof partialRec.stderr === 'string' ? partialRec.stderr : '';
  const exitCode = typeof resultRec.exitCode === 'number' ? resultRec.exitCode : typeof resultRec.code === 'number' ? resultRec.code : undefined;
  const raw = [
    ['Args', args],
    ['Partial', partial],
    ['Result', result],
  ].filter(([, value]) => value !== undefined);
  return { title: command ? `Ran ${command}` : entry.text.replace(/^▸\s*/, '') || entry.tool?.name || 'tool', command, output, stderr, exitCode, raw };
};

const entryAction = (entry?: TranscriptEntry): string => {
  if (!entry) return 'Preparing';
  if (entry.kind === 'thinking') return 'Thinking';
  if (entry.kind === 'tool') return toolView(entry).title;
  if (entry.kind === 'assistant') return entry.status === 'running' ? 'Writing response' : 'Responded';
  if (entry.kind === 'system') return entry.text.replace(/^▸\s*/, '') || 'Updating run';
  return 'Queued prompt';
};

const transcriptDownloadText = (entry: TranscriptEntry) => {
  const label = entry.kind === 'user' ? 'You' : entry.kind === 'assistant' ? 'Assistant' : entry.kind.toUpperCase();
  if (entry.kind !== 'tool') return `[${new Date(entry.ts).toLocaleString()}] ${label}:\n${entry.text}`;
  const view = toolView(entry);
  return `[${new Date(entry.ts).toLocaleString()}] TOOL:\n${view.title}\n${view.output || ''}${view.stderr ? `\nSTDERR:\n${view.stderr}` : ''}`;
};

const fmtDuration = (ms?: number) => {
  if (ms == null) return undefined;
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
};

export const runStatusLabel = (running: boolean, elapsedMs?: number) => `${running ? 'Working' : 'Worked'} for ${fmtDuration(elapsedMs ?? 0)}`;

const transcriptIsRunning = (entries: TranscriptEntry[]) => entries.some((entry) => entry.status === 'running');

const agentIsRunning = (agent?: AgentDTO) => agent?.status === 'working' || agent?.status === 'starting';

const transcriptStart = (entries: TranscriptEntry[], messages: Message[], agent?: AgentDTO) => agent?.startedAt ?? entries[0]?.ts ?? messages[0]?.timestamp ?? Date.now();

const transcriptEnd = (entries: TranscriptEntry[], now: number, agent?: AgentDTO) => (
  agentIsRunning(agent) || transcriptIsRunning(entries)
    ? now
    : agent?.receipt?.durationMs && agent?.startedAt
      ? agent.startedAt + agent.receipt.durationMs
      : entries.at(-1)?.ts ?? now
);

const splitTranscriptEntries = (entries: TranscriptEntry[]) => {
  const visibleEntries = entries.filter((entry) => entry.text.trim());
  const firstWorkIndex = visibleEntries.findIndex((entry) => entry.kind !== 'user');
  if (firstWorkIndex < 0) return { promptEntries: visibleEntries, workEntries: EMPTY_TRANSCRIPT, finalEntry: undefined };
  const promptEntries = visibleEntries.slice(0, firstWorkIndex);
  const workEntries = visibleEntries.slice(firstWorkIndex);
  const finalEntry = [...workEntries].reverse().find((entry) => entry.kind === 'assistant' && entry.status !== 'running');
  return { promptEntries, workEntries, finalEntry };
};

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
    className="flex min-h-9 w-full items-center gap-2 border-t border-gray-200 pt-3 text-left text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
    aria-expanded={expanded}
  >
    <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
    <Clock3 className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
    <span className="flex-shrink-0">{runStatusLabel(running, elapsedMs)}</span>
    {running && <span className="min-w-0 truncate shimmer">{action}</span>}
  </button>
);

const GateWidget = ({
  request,
  onAnswer,
}: {
  request: PendingRequest;
  onAnswer: (value: string) => void;
}) => {
  const [text, setText] = useState('');
  if (request.options && request.options.length > 0) {
    return (
      <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/60 dark:bg-amber-950/20">
        <div className="mb-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{request.title}</div>
        <div className="flex flex-wrap gap-2">
          {request.options.map((opt) => (
            <button
              key={opt}
              onClick={() => onAnswer(opt)}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/60 dark:bg-amber-950/20">
      <div className="mb-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{request.title}</div>
      {request.message && <div className="mb-2 text-[11px] text-gray-600 dark:text-gray-400">{request.message}</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (text.trim()) { onAnswer(text.trim()); setText(''); }
          }
        }}
        rows={2}
        placeholder={request.placeholder ?? 'Type your reply…'}
        className="w-full resize-y rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-700 dark:bg-gray-950 dark:text-gray-100"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={() => { if (text.trim()) { onAnswer(text.trim()); setText(''); } }}
          disabled={!text.trim()}
          className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3 w-3" aria-hidden />
          Send
        </button>
      </div>
    </div>
  );
};

export const DiffReviewPanel = ({ diffs }: { diffs: AgentFileDiff[] }) => {
  if (!diffs.length) return null;
  return (
    <section className="rounded-lg border border-gray-200 bg-white/70 p-2.5 text-xs dark:border-gray-800 dark:bg-gray-900/40" aria-label="Changed files">
      <details>
        <summary className="flex cursor-pointer list-none items-center gap-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">
          <FileText className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <span className="font-medium">{diffs.length} changed {diffs.length === 1 ? 'file' : 'files'}</span>
          <span className="ml-auto text-[11px]">Review diff</span>
        </summary>
        <div className="mt-2 space-y-2">
          {diffs.map((diff) => (
            <details key={diff.file} className="rounded-md bg-gray-50 px-2 py-1.5 dark:bg-gray-950">
              <summary className="cursor-pointer list-none truncate font-mono text-[11px] text-gray-700 dark:text-gray-300">
                {diff.status ? `${diff.status} ` : ''}{diff.file}
              </summary>
              {diff.diff && <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-gray-950 p-2 text-[10px] leading-relaxed text-gray-100 whitespace-pre scrollbar-custom">{diff.diff}</pre>}
            </details>
          ))}
        </div>
      </details>
    </section>
  );
};

export const TranscriptTimeline = ({
  entries,
  messages,
  agent,
  now,
  diffs = EMPTY_DIFFS,
  expanded,
  onToggle,
  onAnswer,
}: {
  entries: TranscriptEntry[];
  messages: Message[];
  agent?: AgentDTO;
  now: number;
  diffs?: AgentFileDiff[];
  expanded: boolean;
  onToggle: () => void;
  onAnswer?: (requestId: string, value: string) => void;
}) => {
  const { promptEntries, workEntries, finalEntry } = splitTranscriptEntries(entries);
  const running = agentIsRunning(agent) || transcriptIsRunning(entries);
  const elapsedMs = transcriptEnd(entries, now, agent) - transcriptStart(entries, messages, agent);
  const latestWork = [...workEntries].reverse().find((entry) => entry.kind !== 'assistant' || entry.status === 'running') ?? workEntries.at(-1);
  const hiddenWorkEntries = !running && finalEntry ? workEntries.filter((entry) => entry !== finalEntry) : workEntries;

  const renderEntry = (entry: TranscriptEntry) => {
    const gateRequest =
      entry.kind === 'system' && entry.pending?.action === 'created' && agent && onAnswer
        ? agent.pending.find((p) => p.id === entry.pending!.requestId)
        : undefined;
    return (
      <>
        <TranscriptEntryView entry={entry} />
        {gateRequest && onAnswer && (
          <GateWidget request={gateRequest} onAnswer={(value) => onAnswer(gateRequest.id, value)} />
        )}
      </>
    );
  };

  return (
    <>
      {promptEntries.map((entry) => (
        <React.Fragment key={entry.id ?? `${entry.ts}:${entry.kind}:${entry.text}`}>
          {renderEntry(entry)}
        </React.Fragment>
      ))}
      <RunStatusHeader running={running} elapsedMs={elapsedMs} action={entryAction(latestWork)} expanded={expanded} onToggle={onToggle} />
      {expanded && hiddenWorkEntries.map((entry) => (
        <React.Fragment key={entry.id ?? `${entry.ts}:${entry.kind}:${entry.text}`}>
          {renderEntry(entry)}
        </React.Fragment>
      ))}
      {!running && finalEntry && (
        <div className="space-y-3">
          {renderEntry(finalEntry)}
          <DiffReviewPanel diffs={diffs} />
        </div>
      )}
      {running && <DiffReviewPanel diffs={diffs} />}
    </>
  );
};

export const TranscriptEntryView = ({ entry }: { entry: TranscriptEntry }) => {
  if (entry.kind === 'user') {
    return (
      <div className="flex flex-col w-full items-end">
        <div className="flex flex-col items-end gap-1 max-w-[88%]">
          <div className="rounded-2xl rounded-tr-md bg-gray-200 px-3.5 py-2.5 text-[13px] leading-relaxed text-gray-900 whitespace-pre-wrap dark:bg-gray-900 dark:text-gray-100">
            {entry.text}
          </div>
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
        <div className="flex items-center gap-2 py-1.5 text-[11px] text-gray-400 dark:text-gray-500">
          <div className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
          <span className="font-medium uppercase tracking-wider">{label}</span>
          <div className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
        </div>
      );
    }
    const view = toolView(entry);
    const running = entry.status === 'running';
    const toolLabel = (entry.tool?.name ?? 'Tool').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const hasBody = view.command || view.output || view.stderr || view.raw.length > 0;
    return (
      <details open={running} className="group rounded-md">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-900/60">
          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(entry.status)} ${running ? 'animate-pulse' : ''}`} aria-label={entry.status ?? 'ok'} />
          <span className="font-semibold text-gray-900 dark:text-gray-100">{toolLabel}</span>
          <span className={`min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400 ${running ? 'shimmer' : ''}`}>{view.title !== toolLabel ? view.title : ''}</span>
          {hasBody && <ChevronRight className="ml-auto h-3 w-3 flex-shrink-0 text-gray-300 transition-transform group-open:rotate-90 dark:text-gray-600" aria-hidden />}
        </summary>
        {hasBody && (
          <div className="mt-1 ml-4 space-y-1.5 text-[11px]">
            {view.command && (
              <div className="flex gap-2">
                <span className="w-6 flex-shrink-0 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">IN</span>
                <code className="flex-1 rounded bg-gray-100 px-2 py-1.5 font-mono leading-relaxed text-gray-700 dark:bg-gray-900 dark:text-gray-300 whitespace-pre-wrap">{view.command}</code>
              </div>
            )}
            {view.output && (
              <div className="flex gap-2">
                <span className="w-6 flex-shrink-0 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">OUT</span>
                <pre className="max-h-48 flex-1 overflow-auto rounded bg-gray-100 px-2 py-1.5 leading-relaxed text-gray-700 dark:bg-gray-900 dark:text-gray-300 whitespace-pre-wrap scrollbar-custom">{view.output}</pre>
              </div>
            )}
            {view.stderr && (
              <div className="flex gap-2">
                <span className="w-6 flex-shrink-0 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-red-400">ERR</span>
                <pre className="max-h-32 flex-1 overflow-auto rounded bg-red-50 px-2 py-1.5 leading-relaxed text-red-800 dark:bg-red-950/30 dark:text-red-200 whitespace-pre-wrap scrollbar-custom">{view.stderr}</pre>
              </div>
            )}
            {(view.exitCode !== undefined || entry.tool?.durationMs !== undefined) && (
              <div className="flex items-center gap-2 pl-8 text-[10px] text-gray-400 dark:text-gray-500">
                {view.exitCode !== undefined && <span>exit {view.exitCode}</span>}
                {entry.tool?.durationMs !== undefined && <span>{fmtDuration(entry.tool.durationMs)}</span>}
              </div>
            )}
            {view.raw.length > 0 && (
              <details className="group/raw ml-8">
                <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded px-1.5 text-[10px] text-gray-400 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-500 dark:hover:bg-gray-900">
                  <ChevronRight className="h-3 w-3 transition-transform group-open/raw:rotate-90" aria-hidden />
                  Raw payload
                </summary>
                <div className="mt-1 space-y-2">
                  {view.raw.map(([name, value]) => (
                    <div key={name as string}>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{name as string}</div>
                      <pre className="max-h-44 overflow-auto rounded-md bg-gray-950 p-2.5 leading-relaxed text-gray-100 whitespace-pre-wrap scrollbar-custom">{prettyJson(value)}</pre>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </details>
    );
  }

  if (entry.kind === 'thinking') {
    const running = entry.status === 'running';
    return (
      <details open={running} className="group rounded-md">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-900">
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 transition-transform group-open:rotate-90" aria-hidden />
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-blue-500 dark:text-blue-400" aria-hidden />
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
      <div className="rounded-md bg-gray-100 px-2 py-1.5 text-[11px] font-mono leading-relaxed text-gray-600 dark:bg-gray-900 dark:text-gray-400 whitespace-pre-wrap">
        {entry.text}
      </div>
    );
  }

  return (
    <div className="w-full text-gray-800 dark:text-gray-300">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-gray-500">
        {entry.kind === 'assistant' ? 'glance' : entry.kind} <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span> {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {entry.status === 'running' && <span className="shimmer text-[10px]">streaming</span>}
      </div>
      <div className="markdown-body prose dark:prose-invert prose-sm max-w-none text-gray-800 dark:text-gray-300 prose-headings:text-sm prose-headings:font-semibold prose-headings:mb-1 prose-headings:mt-2">
        <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ code: CodeBlock }}>{entry.text}</Markdown>
      </div>
    </div>
  );
};

const todoDotStyle: Record<TodoStatus, string> = {
  completed: 'border-emerald-500 bg-emerald-500 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-emerald-950',
  in_progress: 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-blue-950',
  pending: 'border-gray-300 bg-transparent text-transparent dark:border-gray-700',
};

export const TodoPanel = ({ phases, collapsed, onToggle }: { phases: TodoPhaseDTO[]; collapsed: boolean; onToggle: () => void }) => {
  const tasks = phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })));
  if (!tasks.length) return null;
  const done = tasks.filter((task) => task.status === 'completed').length;
  const active = tasks.find((task) => task.status === 'in_progress');
  const pct = Math.round((done / tasks.length) * 100);

  return (
    <section className="flex-shrink-0 border-b border-gray-200 bg-white/95 dark:border-gray-800 dark:bg-gray-950/95">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-10 w-full items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:hover:bg-gray-900 dark:focus-visible:ring-offset-gray-950"
        aria-expanded={!collapsed}
      >
        <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Todo</span>
            {active && <span className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">{active.content}</span>}
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-900 dark:text-gray-300">{done}/{tasks.length}</span>
      </button>
      {!collapsed && (
        <div className="space-y-2 px-4 pb-3">
          {phases.map((phase) => (
            <div key={phase.name}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{phase.name}</div>
              <div className="space-y-1">
                {phase.tasks.map((task) => (
                  <div key={`${phase.name}:${task.content}`} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <span className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border ${todoDotStyle[task.status]}`}>
                      {task.status === 'completed' ? <Check className="h-2.5 w-2.5" aria-hidden /> : task.status === 'in_progress' ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
                    </span>
                    <span className={`truncate ${task.status === 'completed' ? 'text-gray-400 line-through decoration-current/40 dark:text-gray-500' : ''}`}>{task.content}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
const fmtTokens = (n?: number) => n == null ? undefined : n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}K` : `${(n / 1_000_000).toFixed(1)}M`;
const ctxTone = (pct?: number) => pct == null ? 'text-gray-500 dark:text-gray-400' : pct > 0.9 ? 'text-red-600 dark:text-red-400' : pct > 0.7 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300';

const gitSummary = (agent?: AgentDTO, changedFiles?: number | null) => {
  if (!agent) return '';
  const changes = changedFiles == null ? 'checking…' : changedFiles === 0 ? 'clean' : `${changedFiles} changed`;
  return agent.branch ? `${agent.branch} · ${changes}` : changes;
};

export const AgentMetaBar = ({ agent, changedFiles, children }: { agent?: AgentDTO; changedFiles?: number | null; children?: React.ReactNode }) => {
  if (!agent) return null;
  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white px-4 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400" aria-label="Agent mode and git status">
      <span className="rounded-full border border-gray-200 px-1.5 py-0.5 uppercase text-gray-600 dark:border-gray-800 dark:text-gray-300" title={agent.blockedReason ? `Blocked: ${agent.blockedReason}` : `Requested ${agent.autonomyMode ?? 'assist'}; effective ${agent.effectiveMode ?? 'assist'}`}>{agent.effectiveMode ?? 'assist'}</span>
      <span className="rounded-full border border-gray-200 px-1.5 py-0.5 text-gray-600 dark:border-gray-800 dark:text-gray-300" title={agent.proof?.fingerprint ?? 'No proof fingerprint'}>proof: {agent.verificationState ?? 'unknown'}</span>
      <span className="truncate font-mono" title={`${agent.repo}${agent.branch ? ` · ${agent.branch}` : ''}`}>{gitSummary(agent, changedFiles)}</span>
      {children ? <div className="ml-auto flex flex-shrink-0 items-center gap-1">{children}</div> : null}
    </div>
  );
};

/**
 * Verify + Land for the focused agent. Restores the land path the webapp shell replacement
 * dropped — and unlike the legacy feature-card buttons it works for ANY branch agent,
 * ad-hoc `omp-squad add` ones included. The daemon's proofGate stays authoritative: a land
 * without a fresh proof answers 409 with the reason; we surface it and arm a one-shot
 * Force land for the operator who insists.
 */
export const AgentLandControls = ({ agent, showToast }: { agent?: AgentDTO; showToast: (message: string, type?: ToastTone) => void }) => {
  const [busy, setBusy] = React.useState<null | 'verify' | 'land'>(null);
  const [forceArmed, setForceArmed] = React.useState(false);
  const [lastBlock, setLastBlock] = React.useState('');
  const agentKey = agent?.id;
  React.useEffect(() => { setForceArmed(false); setLastBlock(''); }, [agentKey]);
  if (!agent || !canLand(agent)) return null;
  const id = agent.id;

  const runVerify = async () => {
    setBusy('verify');
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}/verify`, jsonInit('POST', {}));
      if (!res.ok) { showToast(`Verify failed: ${await res.text().catch(() => res.status)}`, 'error'); return; }
      const toast = verifyToast(await res.json() as ProofResultDTO);
      showToast(toast.text, toast.tone);
    } catch (error) {
      showToast(`Verify failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const runLand = async (force: boolean) => {
    setBusy('land');
    try {
      // A force land must carry an operator reason (the manager refuses without one) — the
      // prior block detail IS the reason the operator saw and chose to override.
      const payload = force ? { force: true, reason: `web operator override — prior block: ${lastBlock || 'unknown'}` } : {};
      const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}/land`, jsonInit('POST', payload));
      const body = await res.json().catch(() => null) as LandResultDTO | null;
      if (!body) { showToast(`Land failed: HTTP ${res.status}`, 'error'); return; }
      const toast = landToast(body);
      showToast(toast.text, toast.tone);
      // A blocked land (usually the proof gate) arms a one-shot, visibly-distinct Force.
      setForceArmed(!body.ok && !body.staged);
      setLastBlock(!body.ok && !body.staged ? (body.detail ?? body.message ?? 'blocked') : '');
    } catch (error) {
      showToast(`Land failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const pill = 'flex min-h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <>
      <button
        type="button"
        disabled={busy != null}
        onClick={() => void runVerify()}
        title="Run the repo's acceptance command in this worktree and record a land proof"
        className={`${pill} border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800`}
      >
        {busy === 'verify' ? 'Verifying…' : 'Verify'}
      </button>
      <button
        type="button"
        disabled={busy != null}
        onClick={() => void runLand(forceArmed)}
        title={forceArmed ? 'Land was blocked — force skips the proof gate' : `Merge ${agent.branch} into main (proof-gated)`}
        className={`${pill} ${forceArmed
          ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/40'
          : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/40'}`}
      >
        {busy === 'land' ? 'Landing…' : forceArmed ? 'Force land ⚠' : agent.landReady ? 'Land ✓' : 'Land'}
      </button>
    </>
  );
};

export const ComposerStats = ({ agent }: { agent?: AgentDTO }) => {
  if (!agent) return null;
  const ctx = agent.contextPct == null ? undefined : `${(agent.contextPct * 100).toFixed(1)}%${agent.contextWindow ? `/${fmtTokens(agent.contextWindow)}` : ''}`;
  const tokens = fmtTokens(agent.receipt?.tokens);
  const duration = fmtDuration(agent.receipt?.durationMs ?? (agent.startedAt ? Date.now() - agent.startedAt : undefined));
  const parts = [
    ctx && <span key="ctx" className={ctxTone(agent.contextPct)} title={agent.contextWindow ? `${agent.contextTokens ?? '?'} / ${agent.contextWindow} context tokens` : 'context used'}>{ctx}</span>,
    tokens && <span key="tokens" title="tokens">{tokens} tok</span>,
    agent.receipt?.toolCalls != null && <span key="tools" title="tool calls">{agent.receipt.toolCalls} tools</span>,
    duration && <span key="time" title="run time">{duration}</span>,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-gray-500 dark:text-gray-400" aria-label="Run metrics">{parts.map((part, index) => <React.Fragment key={index}>{index > 0 && <span className="text-gray-300 dark:text-gray-700">·</span>}{part}</React.Fragment>)}</div>;
};

interface SuggestionChip {
  label: string;
  prompt: string;
}

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


export const AssistantChat = ({ onClose }: { onClose: () => void }) => {
  const { agents, features, audit, tasks, selectedTaskId, currentProject, transcripts, sendConsoleCommand, subscribeConsole, openedConsoleAgentId, showToast } = useTaskContext();
  const [initialChatState] = useState(readInitialChatState);
  const [sessions, setSessions] = useState<Session[]>(initialChatState.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialChatState.activeSessionId);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [todoCollapsed, setTodoCollapsed] = useState(false);
  const [agentDiffs, setAgentDiffs] = useState<AgentFileDiff[] | null>(null);
  const [workExpanded, setWorkExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ label: 'omp default', value: '' }]);
  const [selectedModel, setSelectedModel] = useState('');
  const [chatWidth, setChatWidth] = useState(storedChatWidth);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const promotedPlanDirs = useRef<Set<string>>(new Set());
  const chatPanelRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const messages = activeSession?.messages || [];
  const agentId = activeSession?.metadata?.agentId;
  const selectedAgent = agentId ? agents.find((agent) => agent.id === agentId) : undefined;
  const transcriptEntries = agentId ? (transcripts.get(agentId) ?? EMPTY_TRANSCRIPT) : EMPTY_TRANSCRIPT;
  const todoPhases = selectedAgent?.todoPhases ?? [];
  const hasTranscript = transcriptEntries.length > 0;
  const visibleMessages = hasTranscript ? [] : messages;
  const transcriptRunning = transcriptIsRunning(transcriptEntries);
  const agentRunning = agentIsRunning(selectedAgent) || transcriptRunning || isLoading;
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

  useEffect(() => {
    if (!agentRunning) {
      setNow(Date.now());
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [agentRunning]);

  const updateSessionMessages = (sessionId: string, newMessages: Message[]) => {
    setSessions(prev => prev.map(s => {
      if (s.id === sessionId) {
        const title = s.title === 'New Chat' && newMessages.length > 1 && newMessages[1].role === 'user' 
          ? newMessages[1].text.substring(0, 30) + '...'
          : s.title;
        return { ...s, messages: newMessages, updatedAt: Date.now(), title };
      }
      return s;
    }));
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions));
  }, [sessions, isLoading, activeSessionId, transcriptEntries]);

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

  const handleSend = async (forcedInput?: string) => {
    const textToSend = forcedInput || input.trim();
    if (!textToSend || isLoading || !activeSessionId) return;
    
    setInput('');
    const clientTurnId = `turn:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const newMessages = [...messages, { role: 'user' as const, text: textToSend, timestamp: Date.now() }];
    updateSessionMessages(activeSessionId, newMessages);
    setIsLoading(true);

    try {
      let nextAgentId = activeSession?.metadata?.agentId;
      if (nextAgentId && !agents.some((agent) => agent.id === nextAgentId)) nextAgentId = undefined;
      if (!nextAgentId) {
        const started = await apiJson<ConsoleStart>('/api/console', jsonInit('POST', { repo: currentProject?.id, model: selectedModel || undefined }));
        nextAgentId = started.agentId;
        subscribeConsole(nextAgentId);
        setSessions(prev => prev.map(session => session.id === activeSessionId ? {
          ...session,
          metadata: { ...session.metadata, agentId: nextAgentId, status: 'active', stage: 'Chat' },
        } : session));
      }
      // Always hand the assistant the same live join the Active Work pane renders, so it can
      // answer "what's being worked on?" (present) AND "what happened while I was away?" (recent
      // past, from the audit log) from one source of truth — plus the selected feature's detail
      // when one is open. Reference context, not an instruction to act.
      const fleetSnapshot = activeWorkDigest(activeWork(agents, features));
      const activitySnapshot = fleetActivityDigest(fleetActivityRollup(audit), fleetActivityLines(audit, agents));
      const taskContext = selectedTask ? `\n\nCurrent feature context:\n${selectedTask.id} — ${selectedTask.title}\n${selectedTask.description}` : '';
      const message = `${textToSend}\n\n[Live context for reference — only act on it if asked]\n${fleetSnapshot}\n\n${activitySnapshot}${taskContext}`;
      sendConsoleCommand({ type: 'prompt', id: nextAgentId, message, clientTurnId });
    } catch (error: any) {
      updateSessionMessages(activeSessionId, [...newMessages, { role: 'model', text: `Error: ${error.message || 'Could not reach glance chat'}`, timestamp: Date.now() }]);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleReaction = (idx: number, reaction: 'like' | 'dislike') => {
    if (!activeSessionId) return;
    setSessions(prev => prev.map(s => {
      if (s.id === activeSessionId) {
        const updated = [...s.messages];
        if (updated[idx].reaction === reaction) {
          delete updated[idx].reaction;
        } else {
          updated[idx].reaction = reaction;
        }
        return { ...s, messages: updated };
      }
      return s;
    }));
  };

  const downloadHistory = () => {
    if (!activeSession) return;
    const content = hasTranscript ? transcriptEntries.map(transcriptDownloadText).join('\n\n-------------------\n\n') : messages.map(m => `[${new Date(m.timestamp).toLocaleString()}] ${m.role === 'user' ? 'You' : 'Assistant'}:\n${m.text}`).join('\n\n-------------------\n\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-history-${activeSession.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === '@') {
      setShowMentions(true);
      setMentionQuery('');
    } else if (showMentions) {
      if (e.key === 'Escape') {
        setShowMentions(false);
      } else if (e.key === 'Backspace' && input.endsWith('@')) {
        setShowMentions(false);
      } else if (e.key.length === 1 || e.key === 'Backspace') {
        // Simple handling for mention query (in a real app this would use a proper cursor/range detection)
        setTimeout(() => {
          const words = (e.target as HTMLTextAreaElement).value.split(' ');
          const lastWord = words[words.length - 1];
          if (lastWord.startsWith('@')) {
            setMentionQuery(lastWord.substring(1));
          } else {
            setShowMentions(false);
          }
        }, 0);
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertMention = (taskId: string, taskTitle: string) => {
    const words = input.split(' ');
    words.pop(); // remove the @ query
    const newValue = [...words, `@${taskTitle}`].join(' ') + ' ';
    setInput(newValue);
    setShowMentions(false);
  };

  const filteredTasks = tasks.filter(t => t.title.toLowerCase().includes(mentionQuery.toLowerCase()));

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
      className="group absolute inset-y-0 left-0 z-30 hidden w-1 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-blue-500/20 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-blue-400/20 lg:flex"
      title="Drag to resize chat. Double-click to reset."
    >
      <span className="h-10 w-px rounded-full bg-gray-300 transition-colors group-hover:bg-blue-500 dark:bg-gray-700 dark:group-hover:bg-blue-400" aria-hidden="true" />
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
          <Sparkles className="w-4 h-4 text-blue-500 dark:text-blue-400" />
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
      <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-4 scrollbar-custom bg-gray-50 dark:bg-gray-950">
        {hasTranscript ? (
          <TranscriptTimeline
            entries={transcriptEntries}
            messages={messages}
            agent={selectedAgent}
            now={now}
            diffs={agentDiffs ?? EMPTY_DIFFS}
            expanded={workExpanded}
            onToggle={() => setWorkExpanded((value) => !value)}
            onAnswer={selectedAgent ? (requestId, value) => {
              sendConsoleCommand(answerCommand(selectedAgent.id, requestId, value));
              showToast(`Answer sent to ${selectedAgent.name}`, 'success');
            } : undefined}
          />
        ) : visibleMessages.map((msg, idx) => (
          <div key={idx} className={`flex flex-col w-full ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            {msg.role === 'user' ? (
              <div className="flex flex-col items-end gap-1 max-w-[85%]">
                <div className="bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-gray-200 px-4 py-3 rounded-2xl rounded-tr-sm text-[14px] leading-relaxed whitespace-pre-wrap">
                  {msg.text}
                </div>
                <span className="text-[10px] text-gray-400 dark:text-gray-500 px-1">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ) : (
              <div className="w-full text-gray-800 dark:text-gray-300">
                <div className="text-[11px] text-gray-500 mb-2 flex items-center gap-2">
                  glance <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></span> {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div className="markdown-body prose dark:prose-invert prose-sm max-w-none text-gray-800 dark:text-gray-300">
                  <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ code: CodeBlock }}>{msg.text}</Markdown>
                </div>
                <div className="flex items-center gap-2 mt-3 text-gray-400 dark:text-gray-500">
                  <button
                    onClick={() => toggleReaction(idx, 'like')}
                    className={`min-h-10 min-w-10 p-2 rounded-md hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950 ${msg.reaction === 'like' ? 'text-green-500 dark:text-green-400 bg-green-50 dark:bg-green-900/20' : ''}`}
                    title="Helpful"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => toggleReaction(idx, 'dislike')}
                    className={`min-h-10 min-w-10 p-2 rounded-md hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950 ${msg.reaction === 'dislike' ? 'text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/20' : ''}`}
                    title="Not helpful"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {isLoading && (
          <div className="flex flex-col w-full items-start text-gray-800 dark:text-gray-300">
            <div className="text-[11px] text-gray-500 dark:text-gray-500 mb-2 flex items-center gap-2">
              glance workflow <span className="w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-600"></span> Starting...
            </div>
            <div className="flex gap-1 items-center h-6">
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></span>
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 bg-white dark:bg-gray-950 flex-shrink-0 border-t border-gray-200 dark:border-gray-800">
        <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide" aria-label="Contextual suggestions">
          {suggestionChips.map((suggestion, index) => (
            <button
              key={suggestion.label}
              type="button"
              onClick={() => handleSend(suggestion.prompt)}
              className="flex min-h-8 items-center gap-1.5 rounded-full border border-gray-200 bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors whitespace-nowrap hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:focus-visible:ring-offset-gray-950"
            >
              {index === 0 && <Sparkles className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" aria-hidden />}
              {suggestion.label}
            </button>
          ))}
        </div>

        <div className="relative bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl flex flex-col focus-within:border-gray-400 dark:focus-within:border-gray-600 transition-colors">
          
          {showMentions && (
            <div className="absolute bottom-full left-0 mb-2 w-full max-h-48 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-lg z-50">
              <div className="p-2 text-xs font-medium text-gray-500 border-b border-gray-200 dark:border-gray-800">
                Mention a task
              </div>
              {filteredTasks.length > 0 ? (
                filteredTasks.map(task => (
                  <button
                    key={task.id}
                    onClick={() => insertMention(task.id, task.title)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-2"
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: task.status === 'done' ? '#10b981' : '#3b82f6' }}></span>
                    {task.title}
                  </button>
                ))
              ) : (
                <div className="px-3 py-4 text-center text-sm text-gray-500">
                  No matching tasks
                </div>
              )}
            </div>
          )}

          <textarea 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type @ to link a task..."
            className="w-full bg-transparent border-none outline-none text-[13px] text-gray-900 dark:text-gray-200 px-3 py-2.5 resize-none min-h-12 max-h-40"
            disabled={isLoading}
            rows={1}
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <select
                value={selectedModel}
                onChange={(event) => handleModelChange(event.target.value)}
                className="h-8 max-w-36 rounded-full border border-gray-200 bg-white px-2 text-[11px] font-medium text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300"
                aria-label="Model"
              >
                {currentModelOptions.map((option) => (
                  <option key={option.value || 'default'} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button type="button" aria-label="Attach file" className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200">
                <Paperclip className="h-4 w-4" aria-hidden />
              </button>
              <button type="button" aria-label="Voice input" className="flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200">
                <Mic className="h-4 w-4" aria-hidden />
              </button>
              <ComposerStats agent={selectedAgent} />
            </div>
            <button
              type="button"
              aria-label="Send message"
              onClick={() => handleSend()}
              disabled={!input.trim() || isLoading}
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
                input.trim() && !isLoading
                  ? 'bg-gray-900 text-white hover:bg-black dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white'
                  : 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-500'
              }`}
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
