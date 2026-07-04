import React from 'react';
import { ChevronLeft, ChevronRight, Copy, X, Plus, Box, CheckCircle2, Search, Sun, Moon, Bot, PanelRight, FileText, GripVertical, MessageSquare, GitBranch, Maximize2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownComponents, PlanBlockContext } from './PlanBlocks';
import { TaskProperties } from './TaskProperties';
import { ProofProvenancePanel } from './ProofProvenancePanel';
import { useTaskContext } from '../context/TaskContext';
import { useTheme } from '../context/ThemeContext';
import { apiJson, jsonInit } from '../lib/api';
import { stoppableAgents, stopCommand, interruptibleAgents, interruptCommand, restartableAgents, restartCommand, removeCommand, setModelCommand, answerCommand, KNOWN_MODELS, fetchCheckpoints, resolveForkTarget, type CheckpointEntryDTO } from '../lib/agent-control';
import { taskRef } from '../lib/task-model';
import { focusTaskSearch } from '../lib/jump';
import { summarizeTask } from '../lib/taskStatus';
import { AgentStatusStrip } from './AgentStatusStrip';
import { TranscriptTimeline } from './AssistantChat';
import { PlanFlowDiagram } from './PlanFlowDiagram';
import type { GraphConcernInput } from '../lib/planGraph';
import type { TaskComment, TaskDecision, TaskRelationship } from '../types';
import type { AgentDTO, ArtifactCommentDTO, PlanAnnotationTargetDTO, TransitionEntry } from '../lib/dto';
import { prStateBadgeClass, prStateBadgeLabel, agentStatusBadgeClass } from '../lib/agent-badges';

interface PipelineConcern {
  file: string;
  path: string;
  title: string;
  status: string;
  complexity?: string;
  open: boolean;
  planeId?: string;
  acceptanceCriteria: string[];
  prerequisites: string[];
  decisions: string[];
  touches: string[];
}

interface PipelineDocument {
  file: string;
  path: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  content: string;
  concern: boolean;
}

interface PipelineIssue {
  id: string;
  identifier?: string;
  name: string;
  state?: string;
  url?: string;
  blockedBy?: string[];
}

interface PipelineFeature {
  createdAt?: number;
  updatedAt?: number;
}

interface PipelinePayload {
  feature?: PipelineFeature;
  concerns: PipelineConcern[];
  documents: PipelineDocument[];
  issues: PipelineIssue[];
  comments: ArtifactCommentDTO[];
  agentIds: string[];
}

interface FeatureModuleResponse {
  moduleUrl: string;
  issueIdentifiers: string[];
  createdIssues: { id: string; identifier?: string; name: string; url?: string }[];
}

interface FeatureModuleRepairResponse {
  moduleUrl: string;
  issueIdentifiers: string[];
  linkedIssues: { id: string; identifier?: string; name: string; url?: string }[];
  closedIssues: { id: string; identifier?: string; name: string; url?: string }[];
}

interface PlaneTicket {
  identifier: string;
  name: string;
  status: string;
  url: string;
}

interface PlaneLinks {
  tickets: PlaneTicket[] | null;
  moduleUrl?: string;
}

const EmptyStateIllustration = () => (
  <svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="mb-6">
    <rect x="25" y="40" width="150" height="120" rx="12" fill="#FDE4D0" className="dark:fill-gray-800" />
    <path d="M50 70H150" stroke="#F0A35A" strokeWidth="6" strokeLinecap="round" className="dark:stroke-amber-500" />
    <path d="M50 100H120" stroke="#F0A35A" strokeWidth="6" strokeLinecap="round" className="dark:stroke-amber-500" />
    <path d="M50 130H90" stroke="#F0A35A" strokeWidth="6" strokeLinecap="round" className="dark:stroke-amber-500" />
    <circle cx="150" cy="130" r="16" fill="#F0A35A" />
    <path d="M144 130L148 134L156 126" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Small status-color badge for one lifecycle status, reusing the roster row's palette
 *  (agentStatusBadgeClass) so the timeline strip's from/to pills never drift from it. */
export function StatusPill({ status }: { status: TransitionEntry['from'] }) {
  return <span className={`rounded px-1 py-0.5 text-[10px] font-semibold uppercase border ${agentStatusBadgeClass(status)}`}>{status}</span>;
}

/** True once a live transition newer than a cached "Load full history" fetch has landed for an agent —
 *  the signal TaskDetail's fullTimelines cache-invalidation effect uses to evict a stale entry so the
 *  strip falls back to the live (capped) tail instead of freezing forever at load time. `cachedAsOf` is
 *  the `at` of the newest entry the full-history fetch saw; `liveTail` is the agent's current capped
 *  `transitions` tail, which always carries the freshest entry via the roster's `agent` events. */
export function fullTimelineStale(cachedAsOf: number, liveTail?: TransitionEntry[]): boolean {
  const latestLive = liveTail && liveTail.length ? liveTail[liveTail.length - 1].at : undefined;
  return latestLive !== undefined && latestLive > cachedAsOf;
}

/** Collapsible lifecycle history strip for one agent's detail row. Renders nothing only when the
 *  agent DTO predates the `transitions` field entirely (an old daemon version) — an empty tail on a
 *  DTO that *does* support the field still renders the chrome (with a quiet placeholder) so the
 *  "Load full history" affordance stays reachable for a freshly reattached/restored agent whose real
 *  history lives in transitions.jsonl, not the capped in-memory tail. `fullEntries` overrides the
 *  capped `agent.transitions` tail once "Load full history" has round-tripped. */
export function LifecycleTimeline({
  agent,
  isOpen,
  fullEntries,
  onToggle,
  onLoadFull,
}: {
  agent: Pick<AgentDTO, 'id' | 'transitions'>;
  isOpen: boolean;
  fullEntries?: TransitionEntry[];
  onToggle: () => void;
  onLoadFull: () => void;
}) {
  if (agent.transitions === undefined) return null;
  const entries = fullEntries ?? agent.transitions;
  return (
    <div className="border-t border-gray-100 dark:border-gray-800">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900/50 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <ChevronRight className={`h-3 w-3 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        <span>Lifecycle</span>
        <span className="ml-auto rounded-full bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500 dark:text-gray-400">{agent.transitions.length}</span>
      </button>
      {isOpen && (
        <div className="px-3 pb-3 pt-1 space-y-1">
          {entries.length === 0 && (
            <div className="text-[11px] italic text-gray-400 dark:text-gray-500">No recent transitions in memory.</div>
          )}
          {entries.slice().reverse().map((t, i) => (
            <div key={`${t.at}-${i}`} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
              <span className="font-mono text-[10px] text-gray-400">{new Date(t.at).toLocaleTimeString()}</span>
              <StatusPill status={t.from} /><span className="text-gray-300">→</span><StatusPill status={t.to} />
              <span className="text-gray-400">{t.reason}</span>
              {t.cause?.error && <span className="truncate text-red-500 dark:text-red-400">{t.cause.error}</span>}
              {t.denied && <span className="text-amber-500 text-[10px] uppercase">denied</span>}
            </div>
          ))}
          {!fullEntries && (
            <button type="button" onClick={onLoadFull} className="text-[10px] text-amber-600 hover:underline">
              Load full history
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Fork from step N" trigger button beside Restart — gated on the persisted `forkAvailable` DTO
 *  field so an old daemon (which never sets it) never shows this, instead of showing it disabled or
 *  404ing when clicked. Renders nothing for any other agent. */
export function ForkButton({
  agent,
  isOpen,
  onClick,
}: {
  agent: Pick<AgentDTO, 'name' | 'forkAvailable'>;
  isOpen: boolean;
  onClick: () => void;
}) {
  if (!agent.forkAvailable) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Fork ${agent.name} from a checkpoint`}
      aria-label="Fork agent"
      className={`min-h-8 rounded-md px-2.5 text-xs font-medium flex items-center gap-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${isOpen ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/30'}`}
    >
      ⑂ Fork
    </button>
  );
}

/** The checkpoint-step picker opened by {@link ForkButton}. Candidate-A semantics for this slice: no
 *  code rewind, so every entry other than the latest is explicitly labeled "routing state only" —
 *  the fork restarts workflow routing at that node with reset fix-up-tier visits, but the new run's
 *  code still starts from the source run's current branch tip (captured `headSha` is data only). */
export function ForkPicker({
  checkpoints,
  selectedSeq,
  onSelect,
  onConfirm,
  onCancel,
}: {
  checkpoints: CheckpointEntryDTO[];
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sorted = [...checkpoints].sort((a, b) => b.seq - a.seq);
  const latestSeq = sorted[0]?.seq;
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-2 py-1 dark:border-amber-900 dark:bg-amber-950/30">
      {sorted.length === 0 ? (
        <span className="text-xs text-gray-500 dark:text-gray-400">No checkpoints recorded yet</span>
      ) : (
        <select
          autoFocus
          value={selectedSeq ?? ''}
          onChange={(e) => onSelect(Number(e.target.value))}
          className="text-xs bg-transparent border-none outline-none text-gray-700 dark:text-gray-200 cursor-pointer"
          aria-label="Fork from checkpoint"
        >
          {sorted.map((c) => (
            <option key={c.seq} value={c.seq}>
              {`Step ${c.seq} — ${c.currentNode}`}
              {c.seq === latestSeq ? ' (latest)' : ''}
            </option>
          ))}
        </select>
      )}
      {selectedSeq !== null && selectedSeq !== latestSeq && (
        <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400">routing state only — code stays at the branch tip</span>
      )}
      <button
        type="button"
        onClick={onConfirm}
        disabled={selectedSeq === null}
        className="text-xs font-medium text-amber-700 dark:text-amber-400 disabled:opacity-40 hover:text-amber-900 focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        Fork
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
    </div>
  );
}

function commentFromApi(comment: ArtifactCommentDTO): TaskComment {
  return { id: comment.id, text: comment.body, timestamp: new Date(comment.createdAt).toISOString(), author: comment.author, urgent: comment.urgent, resolvedAt: comment.resolvedAt, kind: comment.kind, subject: comment.subject, annotation: comment.annotation };
}


const PLAN_MARKDOWN_CLASS = "prose prose-sm max-w-none dark:prose-invert prose-headings:scroll-mt-4 prose-headings:text-gray-900 dark:prose-headings:text-gray-100 prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-li:text-gray-700 dark:prose-li:text-gray-300 prose-strong:text-gray-900 dark:prose-strong:text-gray-100 prose-code:rounded prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-gray-900 dark:prose-code:bg-gray-900 dark:prose-code:text-gray-100 prose-pre:border prose-pre:border-gray-200 prose-pre:bg-gray-50 prose-pre:text-gray-900 dark:prose-pre:border-gray-800 dark:prose-pre:bg-gray-950 dark:prose-pre:text-gray-100 prose-table:text-sm prose-th:border prose-th:border-gray-200 prose-th:bg-gray-50 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-gray-200 prose-td:px-3 prose-td:py-2 dark:prose-th:border-gray-800 dark:prose-th:bg-gray-900 dark:prose-td:border-gray-800";
const PLAN_NAV_BUTTON_CLASS = "inline-flex min-h-8 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-800 dark:text-gray-200 dark:hover:bg-gray-900 dark:focus-visible:ring-offset-gray-950";
const PLAN_DOC_TAB_BASE_CLASS = "group min-h-9 max-w-56 flex-shrink-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950";
const PLAN_DOC_TAB_ACTIVE_CLASS = "border-amber-300 bg-amber-50 text-amber-800 shadow-sm dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200";
const PLAN_DOC_TAB_IDLE_CLASS = "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:bg-gray-900";


export const PlanMarkdown = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { content: string }>(({ content, className = '', ...props }, ref) => (
  <article ref={ref} className={`${PLAN_MARKDOWN_CLASS} ${className}`.trim()} {...props}>
    <Markdown remarkPlugins={[remarkGfm]} components={MarkdownComponents}>{content}</Markdown>
  </article>
));
PlanMarkdown.displayName = 'PlanMarkdown';

export function PlanMarkdownLoading() {
  return (
    <div className="flex h-full min-h-[22rem] flex-col p-6" aria-busy="true" aria-live="polite" role="status">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-amber-100 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
          <FileText className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">Loading plan documents</div>
          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Fetching markdown, annotations, and plan metadata.</div>
        </div>
      </div>
      <div className="space-y-4 animate-pulse">
        <div className="h-5 w-44 rounded bg-gray-200 dark:bg-gray-800" />
        <div className="h-8 w-3/4 rounded bg-gray-200 dark:bg-gray-800" />
        <div className="space-y-2">
          <div className="h-3 rounded bg-gray-100 dark:bg-gray-900" />
          <div className="h-3 rounded bg-gray-100 dark:bg-gray-900" />
          <div className="h-3 w-2/3 rounded bg-gray-100 dark:bg-gray-900" />
        </div>
      </div>
    </div>
  );
}

function lineSpanForQuote(content: string, quote: string): { lineStart?: number; lineEnd?: number } {
  const clean = quote.trim();
  if (!clean) return {};
  const idx = content.indexOf(clean);
  if (idx < 0) return {};
  const lineStart = content.slice(0, idx).split('\n').length;
  const lineEnd = lineStart + clean.split('\n').length - 1;
  return { lineStart, lineEnd };
}

function mergeComments(existing: TaskComment[], incoming: TaskComment): TaskComment[] {
  const idx = existing.findIndex((item) => item.id === incoming.id);
  if (idx < 0) return [...existing, incoming];
  const next = [...existing];
  next[idx] = { ...next[idx], ...incoming };
  return next;
}

interface AnnotationDraft {
  quote: string;
  top: number;
  left: number;
  lineStart?: number;
  lineEnd?: number;
  blockId?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
export const isOverviewDoc = (file: string) => file.toLowerCase() === "00-overview.md";
export function planDocKind(file: string, concern: boolean): "overview" | "concern" | "doc" {
  return isOverviewDoc(file) ? "overview" : concern ? "concern" : "doc";
}
export function safePlanIndex(documents: Array<{ path: string }>, selectedPath?: string | null): number {
  if (documents.length === 0) return -1;
  const index = selectedPath ? documents.findIndex((item) => item.path === selectedPath) : -1;
  return index >= 0 ? clamp(index, 0, documents.length - 1) : 0;
}

export function adjacentPlanPath(documents: Array<{ path: string }>, selectedPath: string | null | undefined, delta: -1 | 1): string | null {
  const index = safePlanIndex(documents, selectedPath);
  if (index < 0) return null;
  const next = index + delta;
  return next >= 0 && next < documents.length ? documents[next].path : null;
}

export function resetPlanScroll(element: { scrollTop: number } | null | undefined): void {
  if (element) element.scrollTop = 0;
}



function formatWhen(ts?: number): string {
  return ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}


function storedNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function authorHue(author?: string): number {
  const text = author?.trim() || 'User';
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

function annotationColors(author?: string) {
  const hue = authorHue(author);
  return {
    mark: `hsla(${hue}, 85%, 55%, 0.28)`,
    border: `hsl(${hue}, 75%, 45%)`,
    card: `hsla(${hue}, 85%, 55%, 0.12)`,
  };
}

function unwrapAnnotationMarks(root: HTMLElement) {
  root.querySelectorAll('mark[data-plan-annotation]').forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
  });
  root.normalize();
}

function textNodesUnder(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('mark[data-plan-annotation]')) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function highlightQuote(root: HTMLElement, annotation: TaskComment) {
  const quote = annotation.annotation?.quote?.trim();
  if (!quote) return;
  const nodes = textNodesUnder(root);
  const fullText = nodes.map((node) => node.textContent ?? '').join('');
  const start = fullText.indexOf(quote);
  if (start < 0) return;
  const end = start + quote.length;
  let cursor = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const text = node.textContent ?? '';
    const next = cursor + text.length;
    if (!startNode && start >= cursor && start <= next) {
      startNode = node;
      startOffset = start - cursor;
    }
    if (!endNode && end >= cursor && end <= next) {
      endNode = node;
      endOffset = end - cursor;
      break;
    }
    cursor = next;
  }
  if (!startNode || !endNode) return;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const mark = document.createElement('mark');
  const colors = annotationColors(annotation.author);
  mark.dataset.planAnnotation = 'true';
  mark.dataset.annotationId = annotation.id;
  mark.className = 'plan-annotation-mark';
  mark.tabIndex = 0;
  mark.setAttribute('role', 'button');
  mark.setAttribute('aria-label', `Annotation by ${annotation.author ?? 'User'}`);
  mark.style.setProperty('--annotation-bg', colors.mark);
  mark.style.setProperty('--annotation-border', colors.border);
  mark.style.backgroundColor = colors.mark;
  mark.style.borderBottom = `2px solid ${colors.border}`;
  try {
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  } catch {
    range.detach();
  }
}

// Recover question id → prompt from a plan doc's ```questions fences. Mirrors QuestionsBlock's
// hand-rolled parser (a `- id: x` item, indented `prompt:` line) just enough to map the two fields,
// so the answers POST can carry the prompt the 3-arg onAnswer contract doesn't include.
function promptsFromContent(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const fence = /```+\s*questions[^\n]*\n([\s\S]*?)```/g;
  const stripQuotes = (value: string) => {
    const t = value.trim();
    return t.length >= 2 && /^["'].*["']$/.test(t) && t[0] === t[t.length - 1] ? t.slice(1, -1) : t;
  };
  for (const block of content.matchAll(fence)) {
    let id: string | null = null;
    for (const rawLine of block[1].split(/\r?\n/)) {
      const itemStart = rawLine.match(/^\s*-\s+(.*)$/);
      const source = itemStart ? itemStart[1] : rawLine;
      if (itemStart) id = null;
      const kv = source.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      if (key === 'id') id = stripQuotes(kv[2]);
      else if ((key === 'prompt' || key === 'question' || key === 'q') && id) map.set(id, stripQuotes(kv[2]));
    }
  }
  return map;
}

export const TaskDetail = () => {
  const { tasks, selectedTaskId, selectTask, updateTask, isChatOpen, setIsChatOpen, addTaskComment, agents, commentEvents, resolvedCommentEvents, showToast, reload, sendConsoleCommand, transcripts, subscribeConsole } = useTaskContext();
  const { theme, toggleTheme } = useTheme();
  const [newCriteriaText, setNewCriteriaText] = React.useState('');
  const [isAddingCriteria, setIsAddingCriteria] = React.useState(false);
  const [criteriaFolded, setCriteriaFolded] = React.useState(false);
  const [newDecisionText, setNewDecisionText] = React.useState('');
  const [newRelationshipText, setNewRelationshipText] = React.useState('');
  const [commentText, setCommentText] = React.useState('');
  const [showProperties, setShowProperties] = React.useState(false);
  const [expandedContext, setExpandedContext] = React.useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = React.useState<string | null>(null);
  const [pipeline, setPipeline] = React.useState<PipelinePayload | null>(null);
  const [planeLinks, setPlaneLinks] = React.useState<PlaneLinks | null>(null);
  const [comments, setComments] = React.useState<TaskComment[]>([]);

  const [annotationText, setAnnotationText] = React.useState('');
  const [annotationDraft, setAnnotationDraft] = React.useState<AnnotationDraft | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = React.useState<string | null>(null);
  const [sendingAnnotationId, setSendingAnnotationId] = React.useState<string | null>(null);
  const [planAction, setPlanAction] = React.useState<'implement' | 'module' | 'module-tickets' | 'repair' | 'clear-orphans' | null>(null);
  const [targetAgentByAnnotation, setTargetAgentByAnnotation] = React.useState<Record<string, string>>({});
  const [mainPanePercent, setMainPanePercent] = React.useState(() => clamp(storedNumber('omp.taskDetail.mainPanePercent', 48), 30, 72));
  // Plan flow "focus" mode: blow the dependency diagram out to a full-pane view (it's far wider
  // than the reading column it previews in).
  const [flowFocus, setFlowFocus] = React.useState(false);
  const [transcriptOpenIds, setTranscriptOpenIds] = React.useState<Set<string>>(() => new Set());
  const [transcriptDetailOpenIds, setTranscriptDetailOpenIds] = React.useState<Set<string>>(() => new Set());
  const [timelineOpenIds, setTimelineOpenIds] = React.useState<Set<string>>(() => new Set());
  // Cached "Load full history" round-trips, keyed by agent id. `asOf` pins the `at` of the newest
  // entry the fetch saw — once a live transition lands with a newer `at` (via the roster's `agent`
  // events, which always carry the fresh capped tail), the effect below evicts the stale cache entry
  // so the strip falls back to the live tail instead of silently freezing at load time.
  const [fullTimelines, setFullTimelines] = React.useState<Map<string, { entries: TransitionEntry[]; asOf: number }>>(() => new Map());
  const [now, setNow] = React.useState(Date.now);
  const splitContainerRef = React.useRef<HTMLDivElement | null>(null);
  const planArticleRef = React.useRef<HTMLElement | null>(null);
  const planScrollRef = React.useRef<HTMLDivElement | null>(null);
  const annotationTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const pipelineRequestRef = React.useRef(0);
  const planeLinksRequestRef = React.useRef(0);
  const task = tasks.find(t => t.id === selectedTaskId);

  const selectedPlanDoc = React.useMemo(() => {
    const docs = pipeline?.documents ?? [];
    return docs.find((item) => item.path === selectedDoc) ?? docs[0] ?? null;
  }, [pipeline, selectedDoc]);

  const selectedConcern = React.useMemo(() => {
    if (!selectedPlanDoc) return undefined;
    return (pipeline?.concerns ?? []).find((concern) => concern.path === selectedPlanDoc.path || concern.file === selectedPlanDoc.file);
  }, [pipeline?.concerns, selectedPlanDoc]);

  const planDocuments = pipeline?.documents ?? [];
  const selectedPlanIndex = safePlanIndex(planDocuments, selectedPlanDoc?.path ?? selectedDoc);
  const previousPlanPath = adjacentPlanPath(planDocuments, selectedPlanDoc?.path ?? selectedDoc, -1);
  const nextPlanPath = adjacentPlanPath(planDocuments, selectedPlanDoc?.path ?? selectedDoc, 1);
  const selectPlanDoc = React.useCallback((path: string) => {
    setSelectedDoc(path);
    setAnnotationDraft(null);
    resetPlanScroll(planScrollRef.current);
  }, []);

  const preferredPlanDoc = React.useCallback((docs: PipelineDocument[]) => docs.find((item) => isOverviewDoc(item.file)) ?? docs[0] ?? null, []);
  const overviewDoc = React.useMemo(() => planDocuments.find((item) => isOverviewDoc(item.file)) ?? null, [planDocuments]);

  const featureId = task?.sourceId ?? task?.id;
  const repo = task?.properties.project.id;
  const planAnnotations = React.useMemo(() => comments.filter((comment) => comment.kind === 'plan-annotation' && comment.annotation), [comments]);
  const regularComments = React.useMemo(() => comments.filter((comment) => comment.kind !== 'plan-annotation'), [comments]);
  const activeAgents = React.useMemo(() => agents.filter((agent) => task && agent.repo === task.properties.project.id && (agent.featureId === featureId || pipeline?.agentIds.includes(agent.id))), [agents, featureId, pipeline?.agentIds, task]);
  // The webapp could never stop a running agent — the kill command + send path existed but no button
  // sent it. `kill` keeps the agent in the roster (restartable), so this is a safe two-click "Stop".
  const stopTargets = React.useMemo(() => stoppableAgents(activeAgents), [activeAgents]);
  const interruptTargets = React.useMemo(() => interruptibleAgents(activeAgents), [activeAgents]);
  const restartTargets = React.useMemo(() => restartableAgents(activeAgents), [activeAgents]);
  // Agents offering a fork point (persisted `forkAvailable`, survives a daemon restart) — an old
  // daemon that never sets the field simply never populates this list, so the button stays hidden
  // instead of 404ing or rendering disabled.
  const forkTargets = React.useMemo(() => activeAgents.filter((agent) => agent.forkAvailable), [activeAgents]);
  const hasPlan = !!overviewDoc || planDocuments.length > 0;
  const planFlowConcerns = React.useMemo<GraphConcernInput[]>(
    () => (pipeline?.concerns ?? []).map((c) => ({ file: c.path, title: c.title, status: c.status, open: c.open, complexity: c.complexity, prerequisites: c.prerequisites, touches: c.touches })),
    [pipeline?.concerns],
  );
  const taskStatus = React.useMemo(
    () => summarizeTask(activeAgents, {
      hasPlan,
      criteria: task ? { done: task.acceptanceCriteria.filter((c) => c.completed).length, total: task.acceptanceCriteria.length } : undefined,
    }),
    [activeAgents, hasPlan, task],
  );
  const [stopConfirm, setStopConfirm] = React.useState(false);
  const stopConfirmTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remove confirm state
  const [removeTarget, setRemoveTarget] = React.useState<string | null>(null);
  const [removeDeleteWorktree, setRemoveDeleteWorktree] = React.useState(false);
  // Model picker state
  const [modelPickerAgentId, setModelPickerAgentId] = React.useState<string | null>(null);
  const [modelPickerValue, setModelPickerValue] = React.useState('');
  // Fork picker state — which agent's checkpoint-step picker is open, its fetched checkpoint
  // history, and the currently-selected step (defaults to latest once the fetch resolves).
  const [forkPickerAgentId, setForkPickerAgentId] = React.useState<string | null>(null);
  const [forkCheckpoints, setForkCheckpoints] = React.useState<CheckpointEntryDTO[]>([]);
  const [forkSelectedSeq, setForkSelectedSeq] = React.useState<number | null>(null);
  // Answer (pending input) state
  const [answerValues, setAnswerValues] = React.useState<Record<string, string>>({});

  React.useEffect(() => { setStopConfirm(false); setRemoveTarget(null); setModelPickerAgentId(null); setForkPickerAgentId(null); setForkCheckpoints([]); setForkSelectedSeq(null); setFlowFocus(false); setTranscriptOpenIds(new Set()); setTranscriptDetailOpenIds(new Set()); }, [selectedTaskId]);
  // Esc leaves plan-flow focus mode.
  React.useEffect(() => {
    if (!flowFocus) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFlowFocus(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flowFocus]);
  // Tick the elapsed-time display every second while any agent is working.
  React.useEffect(() => {
    if (!activeAgents.some((a) => a.status === 'working' || a.status === 'starting')) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeAgents]);
  // Auto-subscribe the first working agent so transcript entries arrive via WS.
  React.useEffect(() => {
    const working = activeAgents.find((a) => a.status === 'working' || a.status === 'starting');
    if (working) subscribeConsole(working.id);
  }, [activeAgents, subscribeConsole]);
  const toggleTranscript = React.useCallback((agentId: string) => {
    setTranscriptOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) { next.delete(agentId); return next; }
      subscribeConsole(agentId);
      next.add(agentId);
      return next;
    });
  }, [subscribeConsole]);
  const toggleTranscriptDetail = React.useCallback((agentId: string) => {
    setTranscriptDetailOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  }, []);
  const toggleTimeline = React.useCallback((agentId: string) => {
    setTimelineOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  }, []);
  const loadFullTimeline = React.useCallback(async (agentId: string) => {
    try {
      const full = await apiJson<TransitionEntry[]>(`/api/agents/${encodeURIComponent(agentId)}/transitions?full=1`);
      const asOf = full.length ? full[full.length - 1].at : 0;
      setFullTimelines((prev) => new Map(prev).set(agentId, { entries: full, asOf }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load full timeline', 'error');
    }
  }, [showToast]);
  // Invalidate a cached full-history load the moment a newer live transition lands for that agent —
  // otherwise fullTimelines freezes the strip at whatever "Load full history" saw and every transition
  // after that click silently vanishes until a full remount (#lifecycle-truth webapp audit finding 1).
  React.useEffect(() => {
    if (fullTimelines.size === 0) return;
    setFullTimelines((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const agent of agents) {
        const cached = next.get(agent.id);
        if (cached && fullTimelineStale(cached.asOf, agent.transitions)) {
          next.delete(agent.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [agents, fullTimelines]);
  const handleStopAgents = () => {
    if (!stopTargets.length) return;
    if (!stopConfirm) {
      setStopConfirm(true);
      if (stopConfirmTimer.current) clearTimeout(stopConfirmTimer.current);
      stopConfirmTimer.current = setTimeout(() => setStopConfirm(false), 4000); // auto-cancel an unconfirmed stop
      return;
    }
    if (stopConfirmTimer.current) clearTimeout(stopConfirmTimer.current);
    setStopConfirm(false);
    for (const agent of stopTargets) sendConsoleCommand(stopCommand(agent.id));
    showToast(stopTargets.length === 1 ? `Stopping ${stopTargets[0].name}…` : `Stopping ${stopTargets.length} agents…`, 'info');
  };
  const handleInterruptAgents = () => {
    for (const agent of interruptTargets) sendConsoleCommand(interruptCommand(agent.id));
    if (interruptTargets.length) showToast(interruptTargets.length === 1 ? `Interrupting ${interruptTargets[0].name}…` : `Interrupting ${interruptTargets.length} agents…`, 'info');
  };
  const handleRestartAgents = () => {
    for (const agent of restartTargets) sendConsoleCommand(restartCommand(agent.id));
    if (restartTargets.length) showToast(restartTargets.length === 1 ? `Restarting ${restartTargets[0].name}…` : `Restarting ${restartTargets.length} agents…`, 'info');
  };
  const handleRemoveConfirm = () => {
    if (!removeTarget) return;
    sendConsoleCommand(removeCommand(removeTarget, removeDeleteWorktree));
    showToast(`Removing agent${removeDeleteWorktree ? ' + worktree' : ''}…`, 'info');
    setRemoveTarget(null);
    setRemoveDeleteWorktree(false);
  };
  const handleSetModel = (agentId: string, model: string) => {
    if (!model.trim()) return;
    sendConsoleCommand(setModelCommand(agentId, model.trim()));
    showToast(`Model set to ${model.trim()}`, 'info');
    setModelPickerAgentId(null);
    setModelPickerValue('');
  };
  const handleOpenForkPicker = (agentId: string) => {
    if (forkPickerAgentId === agentId) {
      setForkPickerAgentId(null);
      setForkCheckpoints([]);
      setForkSelectedSeq(null);
      return;
    }
    setForkPickerAgentId(agentId);
    setForkCheckpoints([]);
    setForkSelectedSeq(null);
    void fetchCheckpoints(agentId).then((entries) => {
      setForkCheckpoints(entries);
      setForkSelectedSeq(entries.length ? Math.max(...entries.map((e) => e.seq)) : null);
    });
  };
  const handleConfirmFork = (agentId: string, agentName: string) => {
    const cmd = resolveForkTarget(agentId, forkCheckpoints, forkSelectedSeq);
    if (!cmd) return;
    sendConsoleCommand(cmd);
    showToast(`Forking ${agentName} from step ${cmd.seq}…`, 'info');
    setForkPickerAgentId(null);
    setForkCheckpoints([]);
    setForkSelectedSeq(null);
  };
  const handleAnswer = (agentId: string, requestId: string) => {
    const value = answerValues[requestId]?.trim();
    if (!value) return;
    sendConsoleCommand(answerCommand(agentId, requestId, value));
    setAnswerValues((prev) => { const next = { ...prev }; delete next[requestId]; return next; });
    showToast('Answer sent', 'info');
  };
  const selectedDocAnnotations = React.useMemo(() => {
    if (!selectedPlanDoc) return [];
    return planAnnotations.filter((comment) => comment.annotation?.planPath === selectedPlanDoc.path);
  }, [planAnnotations, selectedPlanDoc]);

  const loadPipeline = React.useCallback(async () => {
    if (!featureId || !repo) return;
    const requestId = ++pipelineRequestRef.current;
    const payload = await apiJson<PipelinePayload>(`/api/features/${encodeURIComponent(featureId)}/pipeline?repo=${encodeURIComponent(repo)}`);
    if (requestId !== pipelineRequestRef.current) return;
    setPipeline(payload);
    // A 200 partial body (empty org / version skew) can omit documents/comments; coerce before use.
    const docs = Array.isArray(payload?.documents) ? payload.documents : [];
    const cmts = Array.isArray(payload?.comments) ? payload.comments : [];
    setSelectedDoc((current) => current && docs.some((doc) => doc.path === current) ? current : preferredPlanDoc(docs)?.path ?? null);
    if (cmts.length) setComments(cmts.map(commentFromApi));
  }, [featureId, preferredPlanDoc, repo]);

  // Map a question's id → its prompt by scanning the doc's ```questions fences (the QuestionsBlock
  // sends only id+value through the 3-arg onAnswer contract; the server needs the prompt to write a
  // `Q: <prompt> — A: <value>` decision bullet, so we recover it here from the same source markdown).
  const questionPrompts = React.useMemo(() => promptsFromContent(selectedPlanDoc?.content ?? ''), [selectedPlanDoc?.content]);

  // Persist an answered Open Question to the concern's Decisions log, then refresh the pipeline.
  const answerQuestion = React.useCallback(async (blockId: string, questionId: string, value: string) => {
    const file = selectedConcern?.file ?? selectedPlanDoc?.file;
    if (!featureId || !repo || !file) return;
    const prompt = questionPrompts.get(questionId) ?? questionId;
    try {
      await apiJson(`/api/features/${encodeURIComponent(featureId)}/answers`, jsonInit('POST', { repo, file, blockId, questionId, prompt, value }));
      showToast('Answer recorded', 'success');
      await loadPipeline();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not record answer', 'error');
    }
  }, [featureId, repo, selectedConcern?.file, selectedPlanDoc?.file, questionPrompts, loadPipeline, showToast]);

  // Anchor a fresh annotation to a rendered plan block. Reuses the existing annotation composer
  // (annotationDraft → saveAnnotation → POST /annotations) but seeds it with a blockId and leaves
  // line/quote unset — a block anchor, not a text-range anchor. The composer pops near the block.
  const anchorBlockComment = React.useCallback((blockId: string) => {
    const scroll = planScrollRef.current;
    const article = planArticleRef.current;
    const el = article?.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) as HTMLElement | null;
    let top = 16;
    let left = 12;
    if (scroll && el) {
      const rect = el.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const popoverWidth = 336;
      left = clamp(rect.left - scrollRect.left + scroll.scrollLeft, 12, Math.max(12, scroll.clientWidth - popoverWidth - 12));
      top = rect.bottom - scrollRect.top + scroll.scrollTop + 10;
    }
    window.getSelection()?.removeAllRanges();
    setActiveAnnotationId(null);
    setAnnotationText('');
    setAnnotationDraft({ quote: '', top, left, blockId });
  }, []);

  // Affordance for anchoring a comment to a rendered block: Alt/Option-click a block (blocks already
  // carry data-block-id, concerns 05-08) opens the composer for that blockId. Event delegation keeps
  // this in TaskDetail (the block components are out of scope) and leaves plain clicks/selection alone;
  // interactive controls inside a block (inputs, buttons, links) are skipped.
  const handleBlockAnchorClick = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, button, a, select, [contenteditable="true"]')) return;
    const block = target.closest('[data-block-id]') as HTMLElement | null;
    const blockId = block?.getAttribute('data-block-id');
    if (!blockId) return;
    event.preventDefault();
    anchorBlockComment(blockId);
  }, [anchorBlockComment]);

  const planBlockContext = React.useMemo(() => ({
    featureId,
    repo,
    planPath: selectedPlanDoc?.path,
    touches: selectedConcern?.touches ?? [],
    decisions: selectedConcern?.decisions ?? [],
    comments: pipeline?.comments ?? [],
    onAnswer: answerQuestion,
    onAnchorComment: anchorBlockComment,
  }), [anchorBlockComment, answerQuestion, featureId, pipeline?.comments, repo, selectedConcern?.decisions, selectedConcern?.touches, selectedPlanDoc?.path]);

  const loadPlaneLinks = React.useCallback(async () => {
    if (!featureId) return;
    const requestId = ++planeLinksRequestRef.current;
    const payload = await apiJson<PlaneLinks>(`/api/features/${encodeURIComponent(featureId)}/tickets`);
    if (requestId !== planeLinksRequestRef.current) return;
    // The render reads planeLinks.tickets.length in the non-null branch; a partial body with a
    // moduleUrl but no tickets array would crash there. Coerce a missing tickets to null.
    setPlaneLinks(payload ? { ...payload, tickets: Array.isArray(payload.tickets) ? payload.tickets : null } : payload);
  }, [featureId]);

  // Persist a flow-diagram concern edit (STATUS and/or blockers), then refresh the pipeline.
  const editConcern = React.useCallback(async (file: string, patch: { status?: string; blockedBy?: number[] }) => {
    if (!featureId || !repo) return;
    try {
      await apiJson(`/api/features/${encodeURIComponent(featureId)}/concerns`, jsonInit('PATCH', { repo, file, ...patch }));
      showToast('Concern updated', 'success');
      await loadPipeline();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not update concern', 'error');
    }
  }, [featureId, repo, loadPipeline, showToast]);

  React.useEffect(() => {
    pipelineRequestRef.current += 1;
    planeLinksRequestRef.current += 1;
    setPipeline(null);
    setPlaneLinks(null);
    setComments(task?.comments ?? []);
    setSelectedDoc(null);
    if (!task || !featureId || !repo) return;
    void loadPipeline().catch(() => undefined);
    void loadPlaneLinks().catch(() => undefined);
  }, [loadPipeline, loadPlaneLinks, task?.id, featureId, repo]);

  React.useEffect(() => {
    if (!featureId || !repo) return;
    const relevant = commentEvents.filter((comment) => comment.repo === repo && comment.subject === featureId);
    if (!relevant.length) return;
    setComments((prev) => relevant.reduce((next, comment) => mergeComments(next, commentFromApi(comment)), prev));
  }, [commentEvents, featureId, repo]);

  React.useEffect(() => {
    if (resolvedCommentEvents.size === 0) return;
    setComments((prev) => prev.map((comment) => {
      const resolvedAt = resolvedCommentEvents.get(comment.id);
      return resolvedAt ? { ...comment, resolvedAt } : comment;
    }));
  }, [resolvedCommentEvents]);

  React.useEffect(() => {
    window.localStorage.setItem('omp.taskDetail.mainPanePercent', String(mainPanePercent));
  }, [mainPanePercent]);

  React.useEffect(() => {
    if (!annotationDraft) return;
    annotationTextareaRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnnotationDraft(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [annotationDraft]);

  React.useEffect(() => {
    const article = planArticleRef.current;
    if (!article) return;
    const activate = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      const mark = target.closest<HTMLElement>('mark[data-annotation-id]');
      const id = mark?.dataset.annotationId;
      if (!id) return;
      setActiveAnnotationId(id);
      document.getElementById(`annotation-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    const handleClick = (event: MouseEvent) => activate(event.target);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      activate(event.target);
      event.preventDefault();
    };
    article.addEventListener('click', handleClick);
    article.addEventListener('keydown', handleKeyDown);
    return () => {
      article.removeEventListener('click', handleClick);
      article.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedPlanDoc?.path, selectedDocAnnotations]);

  const handleAddCriteria = () => {
    if (!task) return;
    const text = newCriteriaText.trim();
    if (!text) {
      setIsAddingCriteria(false);
      return;
    }
    updateTask(task.id, { acceptanceCriteria: [...task.acceptanceCriteria, { id: Math.random().toString(36).substr(2, 9), text, completed: false, source: 'manual' }] });
    setNewCriteriaText('');
    setIsAddingCriteria(false);
  };

  const handleToggleCriteria = (criteriaId: string) => {
    if (!task) return;
    updateTask(task.id, { acceptanceCriteria: task.acceptanceCriteria.map(c => c.id === criteriaId ? { ...c, completed: !c.completed } : c) });
  };

  const handleDeleteCriteria = (criteriaId: string) => {
    if (!task) return;
    updateTask(task.id, { acceptanceCriteria: task.acceptanceCriteria.filter(c => c.id !== criteriaId) });
  };

  const addDecision = () => {
    if (!task || !newDecisionText.trim()) return;
    const decision: TaskDecision = { id: Math.random().toString(36).substr(2, 9), text: newDecisionText.trim(), source: 'human', createdAt: Date.now() };
    updateTask(task.id, { decisions: [...task.decisions, decision] });
    setNewDecisionText('');
  };

  const addRelationship = () => {
    if (!task || !newRelationshipText.trim()) return;
    const target = newRelationshipText.trim();
    const rel: TaskRelationship = { id: target, targetId: target, targetTitle: target, type: 'related' };
    updateTask(task.id, { relationships: [...task.relationships, rel] });
    setNewRelationshipText('');
  };

  const captureSelection = React.useCallback(() => {
    const article = planArticleRef.current;
    const scroll = planScrollRef.current;
    if (!article || !scroll || !selectedPlanDoc) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const quote = selection.toString().trim();
    if (!quote) return;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if ((anchor && !article.contains(anchor)) || (focus && !article.contains(focus))) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const popoverWidth = 336;
    const left = clamp(rect.left - scrollRect.left + scroll.scrollLeft, 12, Math.max(12, scroll.clientWidth - popoverWidth - 12));
    const top = rect.bottom - scrollRect.top + scroll.scrollTop + 10;
    setActiveAnnotationId(null);
    setAnnotationText('');
    setAnnotationDraft({ quote: quote.slice(0, 1200), top, left, ...lineSpanForQuote(selectedPlanDoc.content, quote) });
  }, [selectedPlanDoc]);

  const startMainResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = splitContainerRef.current;
    if (!container) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const update = (clientX: number) => setMainPanePercent(clamp(((clientX - rect.left) / rect.width) * 100, 30, 72));
    update(event.clientX);
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const nudgeMainSplit = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setMainPanePercent((value) => clamp(value + (event.key === 'ArrowLeft' ? -4 : 4), 30, 72));
  };

  const saveAnnotation = async (sendToPlanner = false) => {
    if (!task || !featureId || !repo || !selectedPlanDoc || !annotationDraft || !annotationText.trim()) return;
    const quote = annotationDraft.quote.trim();
    const saved = commentFromApi(await apiJson<ArtifactCommentDTO>(`/api/features/${encodeURIComponent(featureId)}/annotations?repo=${encodeURIComponent(repo)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // blockId carries a rendered-block anchor (concern 10); omitted for plain text-range annotations.
      body: JSON.stringify({ planPath: selectedPlanDoc.path, body: annotationText.trim(), quote, lineStart: annotationDraft.lineStart, lineEnd: annotationDraft.lineEnd, blockId: annotationDraft.blockId }),
    }));
    setComments((prev) => mergeComments(prev, saved));
    setAnnotationText('');
    setAnnotationDraft(null);
    window.getSelection()?.removeAllRanges();
    if (sendToPlanner) await sendAnnotation(saved, 'planner');
    else showToast('Plan annotation saved', 'success');
  };

  const resolveAnnotation = async (comment: TaskComment) => {
    await apiJson(`/api/features/${encodeURIComponent(featureId ?? '')}/annotations/${encodeURIComponent(comment.id)}/resolve`, { method: 'POST' });
    setComments((prev) => prev.map((item) => item.id === comment.id ? { ...item, resolvedAt: Date.now() } : item));
    showToast('Annotation resolved', 'success');
  };

  const sendAnnotation = async (comment: TaskComment, mode: 'agent' | 'planner') => {
    if (!featureId || !repo) return;
    const agentId = mode === 'agent' ? targetAgentByAnnotation[comment.id] : undefined;
    if (mode === 'agent' && !agentId) {
      showToast('Pick an agent first', 'error');
      return;
    }
    setSendingAnnotationId(comment.id);
    try {
      const result = await apiJson<{ agentId: string }>(`/api/features/${encodeURIComponent(featureId)}/annotations/${encodeURIComponent(comment.id)}/send?repo=${encodeURIComponent(repo)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, agentId }),
      });
      showToast(mode === 'planner' ? `Planner agent started: ${result.agentId}` : `Annotation sent to ${result.agentId}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not send annotation', 'error');
    } finally {
      setSendingAnnotationId(null);
    }
  };

  const submitComment = async () => {
    if (!task || !commentText.trim()) return;
    const saved = await addTaskComment(task.id, commentText);
    if (saved) setComments((prev) => [...prev, saved]);
    setCommentText('');
  };

  const startImplementation = async () => {
    if (!task || !featureId || !repo) return;
    setPlanAction('implement');
    try {
      await apiJson(`/api/features/${encodeURIComponent(featureId)}/agents`, jsonInit('POST', {
        repo,
        name: task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || undefined,
        task: [
          `Implement: ${task.title}`,
          '',
          `Feature id: ${featureId}`,
          task.contextBundle.spec ? `Plan context: ${task.contextBundle.spec}` : '',
          'Use the plan documents as implementation context. Keep changes scoped to the selected plan and leave verification evidence.',
        ].filter(Boolean).join('\n'),
      }));
      showToast('Implementation agent started', 'success');
      void reload().catch(() => undefined);
      void loadPipeline().catch(() => undefined);
      void loadPlaneLinks().catch(() => undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not start implementation', 'error');
    } finally {
      setPlanAction(null);
    }
  };

  const createPlaneModule = async (tickets: boolean) => {
    if (!featureId || !repo) return;
    setPlanAction(tickets ? 'module-tickets' : 'module');
    try {
      const result = await apiJson<FeatureModuleResponse>(`/api/features/${encodeURIComponent(featureId)}/module`, jsonInit('POST', { repo, tickets }));
      const created = result.createdIssues.length;
      const linked = result.issueIdentifiers.length;
      showToast(tickets ? `Plane module ready: ${created || linked} ticket${(created || linked) === 1 ? '' : 's'}` : 'Plane module ready', 'success');
      if (result.moduleUrl) window.open(result.moduleUrl, '_blank', 'noopener,noreferrer');
      void reload().catch(() => undefined);
      void loadPipeline().catch(() => undefined);
      void loadPlaneLinks().catch(() => undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create Plane module', 'error');
    } finally {
      setPlanAction(null);
    }
  };

  const repairPlaneModule = async (closeOrphans: boolean) => {
    if (!featureId || !repo) return;
    setPlanAction(closeOrphans ? 'clear-orphans' : 'repair');
    try {
      const result = await apiJson<FeatureModuleRepairResponse>(`/api/features/${encodeURIComponent(featureId)}/module/repair`, jsonInit('POST', { repo, closeOrphans }));
      showToast(closeOrphans ? `Cleared ${result.closedIssues.length} orphan ticket${result.closedIssues.length === 1 ? '' : 's'}` : `Synced ${result.linkedIssues.length} ticket${result.linkedIssues.length === 1 ? '' : 's'}`, 'success');
      void reload().catch(() => undefined);
      void loadPipeline().catch(() => undefined);
      void loadPlaneLinks().catch(() => undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not repair Plane module', 'error');
    } finally {
      setPlanAction(null);
    }
  };

  const renderContextDetail = () => {
    if (!task || !expandedContext) return null;
    if (expandedContext === 'spec') {
      const docs = pipeline?.documents ?? [];
      return (
        <div className="p-4 bg-gray-50 dark:bg-gray-950 border-t border-gray-100 dark:border-gray-800">
          <div className="mb-3 text-xs text-gray-500 dark:text-gray-400">
            Select a plan document here; it renders in the reading pane on the right.
          </div>
          <div className="space-y-1 max-h-72 overflow-auto pr-1 scrollbar-custom">
            {!pipeline ? (
              <div className="flex min-h-10 items-center gap-2 rounded border border-dashed border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300" aria-busy="true" role="status">
                <FileText className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                Loading plan documents
              </div>
            ) : docs.length === 0 ? (
              <div className="rounded border border-dashed border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">No plan documents found.</div>
            ) : docs.map((item) => (
              <button key={item.path} onClick={() => selectPlanDoc(item.path)} className={`flex min-h-10 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950 ${selectedPlanDoc?.path === item.path ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'}`}>
                <FileText className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{item.path}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (expandedContext === 'criteria') {
      return <div className="p-4 bg-gray-50 dark:bg-gray-950 border-t border-gray-100 dark:border-gray-800 text-sm text-gray-700 dark:text-gray-300 space-y-2">{task.acceptanceCriteria.length ? task.acceptanceCriteria.map(c => <div key={c.id}>• {c.text}</div>) : <div>{task.contextBundle.criteria}</div>}{pipeline?.issues.map(issue => <div key={issue.id}>↳ {issue.identifier ?? issue.id}: {issue.name}</div>)}</div>;
    }
    if (expandedContext === 'prerequisites') {
      const prereqs = (pipeline?.concerns ?? []).flatMap((concern) => concern.prerequisites.map((text) => `${concern.file}: ${text}`));
      return <div className="p-4 bg-gray-50 dark:bg-gray-950 border-t border-gray-100 dark:border-gray-800 text-sm text-gray-700 dark:text-gray-300 space-y-2">{prereqs.length ? prereqs.map((p) => <div key={p}>• {p}</div>) : <div>{task.contextBundle.prerequisites}</div>}</div>;
    }
    if (expandedContext === 'decisions') {
      return <div className="p-4 bg-gray-50 dark:bg-gray-950 border-t border-gray-100 dark:border-gray-800 text-sm text-gray-700 dark:text-gray-300 space-y-2">{task.decisions.length ? task.decisions.map(d => <div key={d.id}>• {d.text}</div>) : <div>{task.contextBundle.decisions}</div>}</div>;
    }
    const touches = (pipeline?.concerns ?? []).flatMap((concern) => concern.touches.map((text) => `${concern.file}: ${text}`));
    return <div className="p-4 bg-gray-50 dark:bg-gray-950 border-t border-gray-100 dark:border-gray-800 text-sm text-gray-700 dark:text-gray-300 space-y-2">{touches.length ? touches.map((item) => <div key={item}>• {item}</div>) : <div>{pipeline?.agentIds.length ? pipeline.agentIds.join(', ') : task.contextBundle.downstream}</div>}</div>;
  };

  const renderPlanDocPane = () => {
    if (!pipeline) {
      return <PlanMarkdownLoading />;
    }
    if (!selectedPlanDoc) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-gray-500 dark:text-gray-400">
          <FileText className="h-8 w-8" aria-hidden="true" />
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">No plan markdown</div>
          <p className="max-w-sm text-xs">This task has no linked plan documents yet. The bundle rows still show criteria, prerequisites, decisions, and downstream context.</p>
        </div>
      );
    }
    return (
      <>
        <div className="flex-shrink-0 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  Plan markdown
                </div>
                <h2 className="truncate text-[15px] font-semibold text-gray-900 dark:text-gray-100">{selectedPlanDoc.title || selectedPlanDoc.file}</h2>
                <div className="mt-1 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400">{selectedPlanDoc.path}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-600 dark:bg-gray-900 dark:text-gray-300">{selectedPlanIndex + 1} of {planDocuments.length}</span>
                  <span>Updated {formatWhen(selectedPlanDoc.updatedAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-2">
                <div className="flex items-center gap-2" aria-label="Plan document navigation">
                  <button
                    type="button"
                    disabled={!previousPlanPath}
                    onClick={() => previousPlanPath && selectPlanDoc(previousPlanPath)}
                    className={PLAN_NAV_BUTTON_CLASS}
                    aria-label="Previous plan document"
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={!nextPlanPath}
                    onClick={() => nextPlanPath && selectPlanDoc(nextPlanPath)}
                    className={PLAN_NAV_BUTTON_CLASS}
                    aria-label="Next plan document"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Plan actions">
                  <button
                    type="button"
                    disabled={planAction !== null}
                    onClick={() => void startImplementation()}
                    className="inline-flex min-h-8 items-center gap-1 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200 dark:focus-visible:ring-offset-gray-950"
                  >
                    <Bot className="h-4 w-4" aria-hidden="true" />
                    {planAction === 'implement' ? 'Starting...' : 'Implement'}
                  </button>
                  <button
                    type="button"
                    disabled={planAction !== null}
                    onClick={() => void createPlaneModule(false)}
                    className={PLAN_NAV_BUTTON_CLASS}
                  >
                    <Box className="h-4 w-4" aria-hidden="true" />
                    {planAction === 'module' ? 'Creating...' : 'Module'}
                  </button>
                  <button
                    type="button"
                    disabled={planAction !== null}
                    onClick={() => void createPlaneModule(true)}
                    className={PLAN_NAV_BUTTON_CLASS}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {planAction === 'module-tickets' ? 'Creating...' : 'Module + tickets'}
                  </button>
                  <button
                    type="button"
                    disabled={planAction !== null}
                    onClick={() => void repairPlaneModule(false)}
                    className={PLAN_NAV_BUTTON_CLASS}
                  >
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    {planAction === 'repair' ? 'Syncing...' : 'Sync tickets'}
                  </button>
                  <button
                    type="button"
                    disabled={planAction !== null}
                    onClick={() => void repairPlaneModule(true)}
                    className={PLAN_NAV_BUTTON_CLASS}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    {planAction === 'clear-orphans' ? 'Clearing...' : 'Clear orphans'}
                  </button>
                </div>
              </div>
            </div>
            {planeLinks && (planeLinks.moduleUrl || planeLinks.tickets === null || (planeLinks.tickets?.length ?? 0) > 0) && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-300" aria-label="Plane links">
                <span className="inline-flex items-center gap-1 font-semibold text-gray-700 dark:text-gray-200">
                  <Box className="h-3.5 w-3.5" aria-hidden="true" />
                  Plane
                </span>
                {planeLinks.moduleUrl && (
                  <a href={planeLinks.moduleUrl} target="_blank" rel="noreferrer" className="rounded border border-gray-200 bg-white px-2 py-1 font-medium text-amber-700 transition-colors hover:bg-amber-50 focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-950 dark:text-amber-300 dark:hover:bg-amber-950/40">
                    Module linked
                  </a>
                )}
                {planeLinks.tickets === null ? (
                  <span className="rounded bg-amber-50 px-2 py-1 font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">Tickets unavailable</span>
                ) : (
                  <span className="rounded bg-gray-100 px-2 py-1 font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">{planeLinks.tickets.length} ticket{planeLinks.tickets.length === 1 ? '' : 's'}</span>
                )}
                {planeLinks.tickets?.slice(0, 4).map((ticket) => (
                  <a key={ticket.identifier} href={ticket.url} target="_blank" rel="noreferrer" className="max-w-44 truncate rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px] text-gray-600 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300 dark:hover:bg-gray-900" title={`${ticket.identifier}: ${ticket.name}`}>
                    {ticket.identifier}
                  </a>
                ))}
                {(planeLinks.tickets?.length ?? 0) > 4 && <span className="text-gray-400">+{(planeLinks.tickets?.length ?? 0) - 4} more</span>}
              </div>
            )}
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">Documents</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">{planDocuments.length} total</div>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-custom" aria-label="Plan documents">
                {planDocuments.map((doc, index) => {
                  const active = doc.path === selectedPlanDoc.path;
                  const kind = planDocKind(doc.file, doc.concern);
                  return (
                    <button
                      key={doc.path}
                      type="button"
                      onClick={() => selectPlanDoc(doc.path)}
                      className={`${PLAN_DOC_TAB_BASE_CLASS} ${active ? PLAN_DOC_TAB_ACTIVE_CLASS : PLAN_DOC_TAB_IDLE_CLASS}`}
                      aria-current={active ? 'page' : undefined}
                      title={doc.path}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${active ? 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200' : 'bg-gray-100 text-gray-500 group-hover:text-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:group-hover:text-gray-200'}`}>{index + 1}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold">{doc.title || doc.file}</span>
                          <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">{kind}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
          <div ref={planScrollRef} className="relative flex-1 overflow-y-auto p-4 scrollbar-custom">
          {annotationDraft && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveAnnotation(false);
              }}
              className="absolute z-30 w-80 rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-800 dark:bg-gray-950"
              style={{ top: annotationDraft.top, left: annotationDraft.left }}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">{annotationDraft.blockId ? 'Comment on block' : 'Annotate selection'}</div>
                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {annotationDraft.blockId ? 'Anchored to this rendered block' : annotationDraft.lineStart ? `Line ${annotationDraft.lineStart}${annotationDraft.lineEnd && annotationDraft.lineEnd !== annotationDraft.lineStart ? `-${annotationDraft.lineEnd}` : ''}` : 'Selected markdown text'}
                  </div>
                </div>
                <button type="button" onClick={() => setAnnotationDraft(null)} className="flex min-h-10 w-10 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-gray-900 dark:hover:text-gray-200" aria-label="Close annotation popover">
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {annotationDraft.quote && (
                <blockquote className="mb-2 max-h-24 overflow-auto rounded border-l-4 border-amber-400 bg-amber-50 p-2 text-xs text-gray-700 dark:bg-amber-950/30 dark:text-gray-300">{annotationDraft.quote}</blockquote>
              )}
              <label htmlFor="plan-annotation-body" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">What should change?</label>
              <textarea
                ref={annotationTextareaRef}
                id="plan-annotation-body"
                value={annotationText}
                onChange={(event) => setAnnotationText(event.target.value)}
                placeholder="Leave a note for collaborators or a planner agent."
                className="min-h-24 w-full resize-none rounded-md border border-gray-200 bg-white p-2 text-sm text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="submit" disabled={!annotationText.trim()} className="min-h-10 rounded-md bg-amber-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-amber-600 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-gray-950">Save</button>
                <button type="button" disabled={!annotationText.trim()} onClick={() => void saveAnnotation(true)} className="min-h-10 rounded-md border border-amber-300 px-3 py-2 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950 dark:focus-visible:ring-offset-gray-950">Save + planner</button>
              </div>
            </form>
          )}
          <PlanBlockContext.Provider value={planBlockContext}>
            <PlanMarkdown
              ref={planArticleRef}
              content={selectedPlanDoc.content}
              onMouseUp={() => window.setTimeout(captureSelection, 0)}
              onKeyUp={captureSelection}
              onClick={handleBlockAnchorClick}
            />
          </PlanBlockContext.Provider>
          <div className="mt-6 space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">Live annotations</h3>
              <span className="text-xs text-gray-400">{selectedDocAnnotations.filter((item) => !item.resolvedAt).length} open</span>
            </div>
            {selectedDocAnnotations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 p-4 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">No annotations on this document yet. Select text in the plan to start one.</div>
            ) : selectedDocAnnotations.map((annotation) => {
              const colors = annotationColors(annotation.author);
              return (
                <div id={`annotation-${annotation.id}`} key={annotation.id} className={`rounded-lg border p-3 transition-colors ${annotation.resolvedAt ? 'border-gray-200 bg-gray-50 opacity-70 dark:border-gray-800 dark:bg-gray-900/40' : activeAnnotationId === annotation.id ? 'ring-2 ring-amber-500' : ''}`} style={!annotation.resolvedAt ? { borderColor: colors.border, backgroundColor: colors.card } : undefined}>
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: colors.border }} />
                      <span className="truncate">{annotation.author ?? 'User'} · {new Date(annotation.timestamp).toLocaleString()}{annotation.annotation?.lineStart ? ` · line ${annotation.annotation.lineStart}${annotation.annotation.lineEnd && annotation.annotation.lineEnd !== annotation.annotation.lineStart ? `-${annotation.annotation.lineEnd}` : ''}` : ''}</span>
                      {(annotation.annotation as PlanAnnotationTargetDTO | undefined)?.blockId && <span className="flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">block</span>}
                    </div>
                    {annotation.resolvedAt ? <span className="text-xs text-gray-400">Resolved</span> : <button onClick={() => void resolveAnnotation(annotation)} className="min-h-10 rounded px-2 text-xs text-gray-500 hover:bg-white focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-gray-900">Resolve</button>}
                  </div>
                  {annotation.annotation?.quote && <blockquote className="mb-2 rounded border-l-4 bg-white/70 p-2 text-xs text-gray-700 dark:bg-gray-950/60 dark:text-gray-300" style={{ borderColor: colors.border }}>{annotation.annotation.quote}</blockquote>}
                  <p className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">{annotation.text}</p>
                  {!annotation.resolvedAt && <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button disabled={sendingAnnotationId === annotation.id} onClick={() => void sendAnnotation(annotation, 'planner')} className="min-h-10 rounded-md bg-gray-900 px-3 py-2 text-xs font-medium text-white focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">Send to planner</button>
                    {activeAgents.length > 0 && (
                      <>
                        <select value={targetAgentByAnnotation[annotation.id] ?? ''} onChange={(event) => setTargetAgentByAnnotation((prev) => ({ ...prev, [annotation.id]: event.target.value }))} className="min-h-10 rounded-md border border-gray-200 bg-white px-2 text-xs focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                          <option value="">Pick agent</option>
                          {activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                        </select>
                        <button disabled={sendingAnnotationId === annotation.id} onClick={() => void sendAnnotation(annotation, 'agent')} className="min-h-10 rounded-md border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 dark:border-gray-800 dark:text-gray-300">Send to agent</button>
                      </>
                    )}
                  </div>}
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  };

  return (
    <main className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950 z-0 transition-colors duration-200">
      <div className="h-10 border-b border-gray-200 dark:border-gray-800 flex items-center justify-end px-3 gap-2 bg-white dark:bg-gray-950 z-10 flex-shrink-0 transition-colors duration-200">
        {interruptTargets.length > 0 && (
          <button type="button" onClick={handleInterruptAgents} title={`Interrupt current turn for ${interruptTargets.length} agent(s)`} aria-label="Interrupt agent" className="min-h-8 rounded-md px-2.5 text-xs font-medium flex items-center gap-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/30">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-current" aria-hidden="true" /> Interrupt{interruptTargets.length > 1 ? ` (${interruptTargets.length})` : ''}
          </button>
        )}
        {stopTargets.length > 0 && (
          <button type="button" onClick={handleStopAgents} title={stopConfirm ? 'Click again to stop' : `Stop ${stopTargets.length} running agent(s)`} aria-label="Stop agent" className={`min-h-8 rounded-md px-2.5 text-xs font-medium flex items-center gap-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-red-500 ${stopConfirm ? 'bg-red-600 text-white hover:bg-red-700' : 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30'}`}>
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-current" aria-hidden="true" /> {stopConfirm ? 'Confirm stop' : `Stop${stopTargets.length > 1 ? ` (${stopTargets.length})` : ''}`}
          </button>
        )}
        {restartTargets.length > 0 && (
          <button type="button" onClick={handleRestartAgents} title={`Restart ${restartTargets.length} stopped agent(s)`} aria-label="Restart agent" className="min-h-8 rounded-md px-2.5 text-xs font-medium flex items-center gap-1.5 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30">
            ↺ Restart{restartTargets.length > 1 ? ` (${restartTargets.length})` : ''}
          </button>
        )}
        {forkTargets.length > 0 && (
          <ForkButton
            agent={forkTargets[0]}
            isOpen={forkPickerAgentId === forkTargets[0].id}
            onClick={() => handleOpenForkPicker(forkTargets[0].id)}
          />
        )}
        {/* Remove confirm dialog */}
        {removeTarget && (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 dark:border-red-900 dark:bg-red-950/30">
            <label className="flex items-center gap-1 text-xs text-red-700 dark:text-red-300 cursor-pointer">
              <input type="checkbox" checked={removeDeleteWorktree} onChange={(e) => setRemoveDeleteWorktree(e.target.checked)} className="h-3 w-3 rounded border-red-300" />
              del worktree
            </label>
            <button type="button" onClick={handleRemoveConfirm} className="text-xs font-medium text-red-700 dark:text-red-300 hover:text-red-900 focus-visible:ring-2 focus-visible:ring-red-500">Confirm remove</button>
            <button type="button" onClick={() => { setRemoveTarget(null); setRemoveDeleteWorktree(false); }} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">✕</button>
          </div>
        )}
        {/* Per-agent model picker — opens when the model button is clicked */}
        {modelPickerAgentId && (
          <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-900">
            <select
              autoFocus
              value={modelPickerValue}
              onChange={(e) => setModelPickerValue(e.target.value)}
              className="text-xs bg-transparent border-none outline-none text-gray-700 dark:text-gray-200 cursor-pointer"
              aria-label="Select model"
            >
              <option value="">pick model…</option>
              {KNOWN_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              type="text"
              value={modelPickerValue}
              onChange={(e) => setModelPickerValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSetModel(modelPickerAgentId, modelPickerValue); if (e.key === 'Escape') { setModelPickerAgentId(null); setModelPickerValue(''); } }}
              placeholder="or type model id…"
              className="w-36 text-xs bg-transparent border-none outline-none text-gray-700 dark:text-gray-200 placeholder:text-gray-400"
            />
            <button type="button" onClick={() => handleSetModel(modelPickerAgentId, modelPickerValue)} disabled={!modelPickerValue.trim()} className="text-xs font-medium text-amber-600 dark:text-amber-400 disabled:opacity-40 hover:text-amber-800 focus-visible:ring-2 focus-visible:ring-amber-500">Set</button>
            <button type="button" onClick={() => { setModelPickerAgentId(null); setModelPickerValue(''); }} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
          </div>
        )}
        {/* Fork-from-checkpoint picker — opens when a Fork button (toolbar or per-agent row) is clicked */}
        {forkPickerAgentId && (
          <ForkPicker
            checkpoints={forkCheckpoints}
            selectedSeq={forkSelectedSeq}
            onSelect={setForkSelectedSeq}
            onConfirm={() => handleConfirmFork(forkPickerAgentId, activeAgents.find((a) => a.id === forkPickerAgentId)?.name ?? forkPickerAgentId)}
            onCancel={() => { setForkPickerAgentId(null); setForkCheckpoints([]); setForkSelectedSeq(null); }}
          />
        )}
        <button onClick={() => focusTaskSearch()} className="min-h-8 rounded-md px-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 text-xs flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-amber-500" title="Focus task search (⌘K)" aria-label="Jump to search"><Search className="w-3.5 h-3.5" /> Jump <span className="bg-gray-100 dark:bg-gray-800 px-1 rounded border border-gray-200 dark:border-gray-700 text-[10px]">⌘K</span></button>
        <button onClick={toggleTheme} className="flex min-h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500" title="Toggle theme" aria-label="Toggle theme">{theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}</button>
        <button onClick={() => setIsChatOpen(!isChatOpen)} className={`flex min-h-8 items-center gap-1.5 px-2.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${isChatOpen ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`}><Bot className="w-3.5 h-3.5" /> Agent</button>
      </div>

      {!task ? (
        // Master list in the MAIN pane — the viewport used to sit empty while the actual task
        // list hid below the fold of the 300px rail. Click a row to open its detail here.
        <div className="flex-1 overflow-y-auto scrollbar-custom bg-gray-50/30 p-6 transition-colors duration-200 dark:bg-gray-900/30">
          {tasks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-gray-400">
              <EmptyStateIllustration />
              <h2 className="mb-2 text-xl font-semibold text-gray-700 dark:text-gray-300">No tasks yet</h2>
              <p className="max-w-sm text-sm">Create a task from the rail, run /plan, or dispatch a Plane issue — plans and features show up here.</p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">Tasks</h2>
                <span className="text-xs text-gray-400">{tasks.length} total — select one to open its plan, proof, and agents</span>
              </div>
              <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-950">
                {tasks.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => selectTask(item.id)}
                    className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:hover:bg-gray-900/60"
                  >
                    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${item.status === 'done' ? 'bg-emerald-500' : item.status === 'active' ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`} aria-label={item.status} />
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">{item.title}</span>
                    {taskRef(item) && <span className="flex-shrink-0 font-mono text-[11px] text-gray-400 dark:text-gray-500">{taskRef(item)}</span>}
                    <span className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-900 dark:text-gray-400">{item.properties.status}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          ref={splitContainerRef}
          className="relative flex-1 overflow-hidden flex flex-col lg:flex-row"
          style={{ '--detail-pane-width': `${mainPanePercent}%` } as React.CSSProperties}
        >
          <section className="min-w-0 flex-1 overflow-y-auto scrollbar-custom lg:flex-none lg:[flex-basis:var(--detail-pane-width)]">
            <div className="mx-auto max-w-5xl px-4 py-5 lg:px-5">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400 text-xs mb-2"><button onClick={() => selectTask(null)} className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" title="Back to all work items"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />Tasks</button><ChevronRight className="w-3 h-3" /><span className="font-medium text-gray-700 dark:text-gray-300">{taskRef(task) ?? task.properties.project.shortCode}</span><ChevronRight className="w-3 h-3" /><span>{task.properties.project.name}</span></div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowProperties(!showProperties)} className={`w-7 h-7 rounded border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 flex items-center justify-center transition-colors ${showProperties ? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200' : 'text-gray-400'}`} title="Toggle Properties" aria-label="Toggle properties panel" aria-expanded={showProperties}><PanelRight className="w-3.5 h-3.5" /></button>
                  <button onClick={() => { navigator.clipboard.writeText(`${taskRef(task) ?? task.id}: ${task.title}`).then(() => showToast('Copied task ID + title', 'info')).catch(() => undefined); }} className="w-7 h-7 rounded border border-gray-200 dark:border-gray-800 text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900 flex items-center justify-center transition-colors focus-visible:ring-2 focus-visible:ring-amber-500" title="Copy task ID + title" aria-label="Copy task ID and title"><Copy className="w-3.5 h-3.5" /></button>
                </div>
              </div>

              <input key={`${task.id}:title`} className="w-full rounded text-2xl font-bold text-gray-900 dark:text-gray-100 mb-5 outline-none leading-tight bg-transparent focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950" defaultValue={task.title} onBlur={(e) => e.currentTarget.value !== task.title && updateTask(task.id, { title: e.currentTarget.value })} />

              <AgentStatusStrip
                status={taskStatus}
                hasPlan={hasPlan}
                implementing={planAction === 'implement'}
                onAnswer={(agentId, requestId, value) => { sendConsoleCommand(answerCommand(agentId, requestId, value)); showToast('Answer sent', 'info'); }}
                onRestart={(agentId) => { sendConsoleCommand(restartCommand(agentId)); showToast('Restarting…', 'info'); }}
                onImplement={() => void startImplementation()}
              />

              {planFlowConcerns.length >= 2 && (
                <details open className="group mb-6 rounded-lg border border-gray-200 dark:border-gray-800">
                  <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 list-none">
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="mr-auto">Plan flow</span>
                    <span className="font-normal normal-case text-gray-400">{planFlowConcerns.length} concerns</span>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFlowFocus(true); }}
                      title="Open full-pane flow view"
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-amber-500"
                    >
                      <Maximize2 className="h-3 w-3" aria-hidden="true" /> Expand
                    </button>
                  </summary>
                  <div className="border-t border-gray-100 dark:border-gray-800 p-3">
                    <PlanFlowDiagram
                      concerns={planFlowConcerns}
                      overviewText={overviewDoc?.content ?? ''}
                      selectedId={selectedPlanDoc?.path}
                      onSelect={(id) => selectPlanDoc(id)}
                      onEdit={editConcern}
                    />
                  </div>
                </details>
              )}

              <div className="mb-5 grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400 sm:grid-cols-3">
                <div><div className="font-semibold uppercase tracking-widest text-gray-400">Status</div><div className="mt-1 font-medium text-gray-900 dark:text-gray-100">{task.properties.status}</div></div>
                <div><div className="font-semibold uppercase tracking-widest text-gray-400">Plan created</div><div className="mt-1">{formatWhen(task.properties.createdAt ?? pipeline?.feature?.createdAt)}</div></div>
                <div><div className="font-semibold uppercase tracking-widest text-gray-400">Plan updated</div><div className="mt-1">{formatWhen(task.properties.updatedAt ?? pipeline?.feature?.updatedAt)}</div></div>
              </div>

              <div className="mb-7"><ProofProvenancePanel task={task} /></div>

              {!overviewDoc && (
                <div className="mb-10">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-100 dark:border-gray-800 pb-2">Description</div>
                  <textarea key={`${task.id}:description`} className="w-full min-h-32 text-gray-700 dark:text-gray-300 leading-relaxed text-[15px] whitespace-pre-wrap bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-800 focus:border-amber-400 focus:ring-2 focus:ring-amber-500/20 rounded p-2 outline-none" defaultValue={task.description} onBlur={(e) => e.currentTarget.value !== task.description && updateTask(task.id, { description: e.currentTarget.value })} placeholder="Describe what the agent needs to do and why." />
                </div>
              )}

              <div className="mb-7">
                <div className="flex items-center justify-between mb-3 border-b border-gray-100 dark:border-gray-800 pb-2">
                  <button type="button" onClick={() => setCriteriaFolded((value) => !value)} className="flex min-h-8 items-center gap-2 rounded text-left text-[11px] font-semibold uppercase tracking-widest text-gray-400 transition-colors hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:text-gray-300" aria-expanded={!criteriaFolded} aria-controls="acceptance-criteria-list">
                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${criteriaFolded ? '' : 'rotate-90'}`} aria-hidden="true" />
                    Acceptance Criteria <span className="text-gray-500 font-medium">{task.acceptanceCriteria.filter(c => c.completed).length} / {task.acceptanceCriteria.length}</span>
                  </button>
                  <button onClick={() => { setCriteriaFolded(false); setIsAddingCriteria(true); }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs font-medium flex items-center gap-1 transition-colors"><Plus className="w-3 h-3" /> Add</button>
                </div>
                {!criteriaFolded && <div id="acceptance-criteria-list" className="space-y-1.5">
                  {task.acceptanceCriteria.length === 0 && !isAddingCriteria ? <div className="text-gray-400 dark:text-gray-500 italic text-sm py-2">No acceptance criteria defined.</div> : task.acceptanceCriteria.map(criteria => (
                    <div key={criteria.id} className="group flex items-start gap-3 p-3 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-gray-300 dark:hover:border-gray-700 bg-white dark:bg-gray-900 transition-colors">
                      <input type="checkbox" checked={criteria.completed} onChange={() => handleToggleCriteria(criteria.id)} className="mt-1 w-4 h-4 text-amber-600 rounded border-gray-300 dark:border-gray-700 focus:ring-amber-500 bg-transparent cursor-pointer" />
                      <div className={`flex-1 text-sm leading-snug ${criteria.completed ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-300'}`}>{criteria.text}</div>
                      <button onClick={() => handleDeleteCriteria(criteria.id)} className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all rounded hover:bg-red-50 dark:hover:bg-red-900/30"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                  {isAddingCriteria && <div className="flex items-start gap-3 p-3 border border-amber-300 dark:border-amber-700 rounded-lg bg-amber-50/30 dark:bg-amber-900/10"><input type="checkbox" disabled className="mt-1 w-4 h-4 text-gray-300 rounded border-gray-200 bg-transparent" /><input autoFocus type="text" value={newCriteriaText} onChange={(e) => setNewCriteriaText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAddCriteria(); if (e.key === 'Escape') setIsAddingCriteria(false); }} placeholder="Add acceptance criteria..." className="flex-1 bg-transparent border-none outline-none text-sm w-full dark:text-gray-200" /><button onClick={handleAddCriteria} className="text-xs px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-medium transition-colors">Save</button></div>}
                </div>}
              </div>

              <details className="group mb-7 rounded-lg border border-gray-200 dark:border-gray-800">
              <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 list-none">
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
                <span className="mr-auto">Plan context, decisions &amp; relationships</span>
                <span className="font-normal normal-case text-gray-400">{task.decisions.length} decision{task.decisions.length === 1 ? '' : 's'} · {task.relationships.length} link{task.relationships.length === 1 ? '' : 's'}</span>
              </summary>
              <div className="space-y-6 border-t border-gray-100 dark:border-gray-800 px-3 py-4">
              <div className="mb-1">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-100 dark:border-gray-800 pb-2 flex items-center gap-2">Context Bundle From Plan <span className="px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 lowercase font-normal">agent input</span></div>
                <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden bg-white dark:bg-gray-900 transition-colors">
                  <div className="px-3 py-2 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"><Box className="w-4 h-4 text-amber-500" /> planning bundle</div><span className="text-[10px] font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700">MD</span></div>
                  <div className="h-0.5 bg-amber-500 w-full"></div>
                  {(['spec', 'criteria', 'prerequisites', 'decisions', 'downstream'] as const).map((key) => (
                    <button key={key} onClick={() => setExpandedContext(expandedContext === key ? null : key)} className="w-full flex min-h-10 items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-b-0 focus-visible:ring-2 focus-visible:ring-amber-500">
                      <div className="grid min-w-0 flex-1 grid-cols-[0.25rem_6.5rem_minmax(0,1fr)] items-center gap-3 text-left"><div className="h-4 w-1 bg-amber-400 rounded-full"></div><span className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase">{key}</span><span className="truncate text-sm text-gray-800 dark:text-gray-200">{task.contextBundle[key]}</span></div><ChevronRight className={`w-4 h-4 flex-shrink-0 text-gray-400 transition-transform ${expandedContext === key ? 'rotate-90' : ''}`} />
                    </button>
                  ))}
                  {renderContextDetail()}
                </div>
              </div>

              <div className="mb-6">
                <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-2 mb-3"><div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Decisions</div></div>
                <div className="space-y-2 mb-3">{task.decisions.map(decision => <div key={decision.id} className="text-sm text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-800 rounded p-3">{decision.text}</div>)}</div>
                <div className="flex gap-2"><input value={newDecisionText} onChange={(e) => setNewDecisionText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addDecision()} placeholder="Record a decision for future agents..." className="flex-1 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-3 py-2" /><button onClick={addDecision} className="px-3 py-2 rounded bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs"><Plus className="w-3 h-3 inline" /> Add</button></div>
              </div>

              <div className="mb-6 pb-6">
                <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-2 mb-4"><div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">Relationships <span className="text-gray-500 font-medium">{task.relationships.length}</span></div></div>
                <div className="space-y-3 mb-3">{task.relationships.map(rel => <div key={rel.id} className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5" /><div><span className="text-gray-500 font-medium mr-2">{rel.targetId}</span><span className="text-gray-800 dark:text-gray-200 font-medium">{rel.targetTitle}</span></div></div>)}</div>
                <div className="flex gap-2"><input value={newRelationshipText} onChange={(e) => setNewRelationshipText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRelationship()} placeholder="Link issue, feature, or doc id..." className="flex-1 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded px-3 py-2" /><button onClick={addRelationship} className="px-3 py-2 rounded bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs"><Plus className="w-3 h-3 inline" /> Add</button></div>
              </div>
              </div>
              </details>

              {activeAgents.length > 0 && (
                <div className="mb-6">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest flex items-center gap-2 mb-3 border-b border-gray-100 dark:border-gray-800 pb-2">
                    Agents <span className="text-gray-500 font-medium">{activeAgents.length}</span>
                  </div>
                  <div className="space-y-2">
                    {activeAgents.map((agent) => {
                      const isTerminal = agent.status === 'stopped' || agent.status === 'error';
                      const isWorking = agent.status === 'working' || agent.status === 'starting';
                      const isAwaiting = agent.status === 'input' || agent.pending.length > 0;
                      const statusColor = agent.status === 'working' ? 'text-emerald-600 dark:text-emerald-400' : agent.status === 'error' ? 'text-red-500' : agent.status === 'input' ? 'text-amber-500' : agent.status === 'stopped' ? 'text-gray-400' : 'text-blue-500';
                      return (
                        <div key={agent.id} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
                          <div className="flex items-center justify-between gap-2 px-3 py-2">
                            <div className="min-w-0 flex items-center gap-2">
                              <span className={`text-[11px] font-semibold uppercase rounded px-1.5 py-0.5 border ${agentStatusBadgeClass(agent.status)}`}>{agent.status}</span>
                              <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{agent.name}</span>
                              {agent.model && <span className={`hidden sm:block text-[10px] ${statusColor}`}>{agent.model}</span>}
                              {agent.prState && <span className={`rounded px-1.5 py-0.5 text-[10px] ${prStateBadgeClass(agent.prState)}`}>{prStateBadgeLabel(agent.prState)}</span>}
                              {agent.prUrl && <a href={agent.prUrl} target="_blank" rel="noreferrer" className="text-[10px] font-medium text-amber-600 underline hover:text-amber-500 dark:text-amber-400">PR #{agent.prNumber}</a>}
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {!isTerminal && isWorking && (
                                <button type="button" onClick={() => sendConsoleCommand(interruptCommand(agent.id))} title="Interrupt current turn" className="min-h-7 rounded px-2 text-[11px] font-medium text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/30 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500">
                                  Interrupt
                                </button>
                              )}
                              {!isTerminal && (
                                <button type="button" onClick={() => sendConsoleCommand(stopCommand(agent.id))} title="Stop this agent" className="min-h-7 rounded px-2 text-[11px] font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30 transition-colors focus-visible:ring-2 focus-visible:ring-red-500">
                                  Stop
                                </button>
                              )}
                              {isTerminal && (
                                <button type="button" onClick={() => sendConsoleCommand(restartCommand(agent.id))} title="Restart this agent" className="min-h-7 rounded px-2 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500">
                                  ↺ Restart
                                </button>
                              )}
                              {agent.forkAvailable && (
                                <button type="button" onClick={() => handleOpenForkPicker(agent.id)} title={`Fork ${agent.name} from a checkpoint`} className={`min-h-7 rounded px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${forkPickerAgentId === agent.id ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/30'}`}>
                                  ⑂ Fork
                                </button>
                              )}
                              <button type="button" onClick={() => { setModelPickerAgentId(modelPickerAgentId === agent.id ? null : agent.id); setModelPickerValue(agent.model ?? ''); }} title="Set model" className={`min-h-7 rounded px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${modelPickerAgentId === agent.id ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}>
                                Model
                              </button>
                              <button type="button" onClick={() => setRemoveTarget(removeTarget === agent.id ? null : agent.id)} title="Remove agent" className={`min-h-7 rounded px-2 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-red-500 ${removeTarget === agent.id ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-red-400'}`}>
                                Remove
                              </button>
                            </div>
                          </div>
                          {/* Inline model picker for this agent */}
                          {modelPickerAgentId === agent.id && (
                            <div className="border-t border-gray-100 dark:border-gray-800 px-3 py-2 flex items-center gap-2">
                              <select value={modelPickerValue} onChange={(e) => setModelPickerValue(e.target.value)} className="text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
                                <option value="">pick model…</option>
                                {KNOWN_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                              </select>
                              <input type="text" value={modelPickerValue} onChange={(e) => setModelPickerValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSetModel(agent.id, modelPickerValue); if (e.key === 'Escape') { setModelPickerAgentId(null); setModelPickerValue(''); } }} placeholder="or type model id…" className="flex-1 text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 text-gray-700 dark:text-gray-200 px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 placeholder:text-gray-400" />
                              <button type="button" onClick={() => handleSetModel(agent.id, modelPickerValue)} disabled={!modelPickerValue.trim()} className="text-xs font-medium px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-amber-500">Set</button>
                            </div>
                          )}
                          {/* Inline fork-from-checkpoint picker for this agent */}
                          {forkPickerAgentId === agent.id && (
                            <div className="border-t border-gray-100 dark:border-gray-800 px-3 py-2">
                              <ForkPicker
                                checkpoints={forkCheckpoints}
                                selectedSeq={forkSelectedSeq}
                                onSelect={setForkSelectedSeq}
                                onConfirm={() => handleConfirmFork(agent.id, agent.name)}
                                onCancel={() => { setForkPickerAgentId(null); setForkCheckpoints([]); setForkSelectedSeq(null); }}
                              />
                            </div>
                          )}
                          {/* Pending input / Answer section */}
                          {isAwaiting && agent.pending.map((req) => (
                            <div key={req.id} className="border-t border-amber-100 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2">
                              <div className="mb-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400">Awaiting input: {req.title}</div>
                              {req.message && <p className="mb-2 text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{req.message}</p>}
                              {req.options && req.options.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {req.options.map((opt) => (
                                    <button key={opt} type="button" onClick={() => { sendConsoleCommand(answerCommand(agent.id, req.id, opt)); showToast('Answer sent', 'info'); }} className="rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500">
                                      {opt}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    value={answerValues[req.id] ?? ''}
                                    onChange={(e) => setAnswerValues((prev) => ({ ...prev, [req.id]: e.target.value }))}
                                    onKeyDown={(e) => { if (e.key === 'Enter') handleAnswer(agent.id, req.id); }}
                                    placeholder={req.placeholder ?? 'Type your answer…'}
                                    className="flex-1 text-xs rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-900 px-2 py-1 text-gray-700 dark:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 placeholder:text-gray-400"
                                  />
                                  <button type="button" onClick={() => handleAnswer(agent.id, req.id)} disabled={!answerValues[req.id]?.trim()} className="text-xs font-medium px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-amber-500">
                                    Send
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                          {/* Lifecycle timeline strip */}
                          <LifecycleTimeline
                            agent={agent}
                            isOpen={timelineOpenIds.has(agent.id)}
                            fullEntries={fullTimelines.get(agent.id)?.entries}
                            onToggle={() => toggleTimeline(agent.id)}
                            onLoadFull={() => void loadFullTimeline(agent.id)}
                          />
                          {/* Live transcript panel */}
                          {(() => {
                            const agentTranscript = transcripts.get(agent.id) ?? [];
                            const isOpen = transcriptOpenIds.has(agent.id);
                            const isDetailOpen = transcriptDetailOpenIds.has(agent.id);
                            if (!isWorking && agentTranscript.length === 0) return null;
                            return (
                              <div className="border-t border-gray-100 dark:border-gray-800">
                                <button
                                  type="button"
                                  onClick={() => toggleTranscript(agent.id)}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900/50 transition-colors focus-visible:ring-2 focus-visible:ring-amber-500"
                                >
                                  <ChevronRight className={`h-3 w-3 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                                  {isWorking && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500 animate-pulse" aria-hidden />}
                                  <span>Live transcript</span>
                                  {agentTranscript.length > 0 && <span className="ml-auto rounded-full bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-500 dark:text-gray-400">{agentTranscript.length}</span>}
                                </button>
                                {isOpen && (
                                  <div className="max-h-[28rem] overflow-y-auto border-t border-gray-100 px-3 pb-3 pt-2 dark:border-gray-800 scrollbar-custom">
                                    <TranscriptTimeline
                                      entries={agentTranscript}
                                      messages={[]}
                                      agent={agent}
                                      now={now}
                                      expanded={isDetailOpen}
                                      onToggle={() => toggleTranscriptDetail(agent.id)}
                                      onAnswer={(requestId, value) => { sendConsoleCommand(answerCommand(agent.id, requestId, value)); showToast('Answer sent', 'info'); }}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="mb-6 pb-6">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest flex items-center gap-2 mb-4 border-b border-gray-100 dark:border-gray-800 pb-2">Comments <span className="text-gray-500 font-medium">{regularComments.length}</span></div>
                <div className="space-y-4">{regularComments.map(comment => <div key={comment.id} className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-lg border border-gray-100 dark:border-gray-800 transition-colors"><div className="flex items-center justify-between mb-2"><span className="text-xs font-medium text-gray-700 dark:text-gray-300">{comment.author ?? 'User'}</span><span className="text-xs text-gray-400">{new Date(comment.timestamp).toLocaleString()}</span></div><p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{comment.text}</p></div>)}</div>
                <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-amber-500/20 focus-within:border-amber-400 transition-all"><textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Add an instruction/comment for agents working this task..." className="w-full p-3 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none min-h-[80px] resize-none" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitComment(); }} /><div className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center text-xs"><span className="text-gray-400">Saved comments are included in feature workflow prompts.</span><button onClick={() => void submitComment()} className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded font-medium transition-colors">Comment</button></div></div>
              </div>
            </div>
          </section>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize task detail and plan markdown panes"
            tabIndex={0}
            onPointerDown={startMainResize}
            onKeyDown={nudgeMainSplit}
            onDoubleClick={() => setMainPanePercent(48)}
            className="group hidden w-2 flex-shrink-0 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-amber-500/15 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-amber-400/15 lg:flex"
            title="Drag to resize panes. Double-click to reset."
          >
            <span className="h-10 w-px rounded-full bg-gray-300 transition-colors group-hover:bg-amber-500 dark:bg-gray-700 dark:group-hover:bg-amber-400" aria-hidden="true" />
          </div>
          <aside className="flex min-h-[22rem] min-w-0 flex-1 flex-col border-t border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-950/60 lg:min-h-0 lg:border-l lg:border-t-0">
            {renderPlanDocPane()}
          </aside>
          {showProperties && <TaskProperties task={task} />}

          {/* Plan flow focus mode — fills the DETAIL pane (full height, no reading-width cap) while the
              plan-markdown pane stays visible on the right. Full-width below lg where the panes stack. */}
          {flowFocus && planFlowConcerns.length >= 2 && (
            <div className="absolute inset-0 z-30 flex flex-col bg-white dark:bg-gray-950 lg:right-auto lg:w-[var(--detail-pane-width)]" role="dialog" aria-modal="true" aria-label="Plan flow">
              <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
                <GitBranch className="h-4 w-4 text-gray-500" aria-hidden="true" />
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Plan flow</span>
                <span className="text-xs text-gray-400">{task.title}</span>
                <span className="ml-auto text-xs text-gray-400">{planFlowConcerns.length} concerns</span>
                <button
                  type="button"
                  onClick={() => setFlowFocus(false)}
                  title="Close (Esc)"
                  className="ml-2 flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> Close
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4 scrollbar-custom">
                <PlanFlowDiagram
                  concerns={planFlowConcerns}
                  overviewText={overviewDoc?.content ?? ''}
                  selectedId={selectedPlanDoc?.path}
                  onSelect={(id) => selectPlanDoc(id)}
                  onEdit={editConcern}
                  orientation="vertical"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
};
