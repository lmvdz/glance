import React from 'react';
import { ChevronLeft, ChevronRight, Copy, X, Plus, Box, CheckCircle2, Search, Sun, Moon, Bot, PanelRight, FileText, GripVertical, MessageSquare } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { TaskProperties } from './TaskProperties';
import { useTaskContext } from '../context/TaskContext';
import { useTheme } from '../context/ThemeContext';
import { apiJson } from '../lib/api';
import type { TaskComment, TaskDecision, TaskRelationship } from '../types';
import type { ArtifactCommentDTO } from '../lib/dto';

interface PipelineConcern {
  file: string;
  path: string;
  title: string;
  status: string;
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

const EmptyStateIllustration = () => (
  <svg width="200" height="200" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="mb-6">
    <rect x="25" y="40" width="150" height="120" rx="12" fill="#E0E7FF" className="dark:fill-gray-800" />
    <path d="M50 70H150" stroke="#818CF8" strokeWidth="6" strokeLinecap="round" className="dark:stroke-indigo-500" />
    <path d="M50 100H120" stroke="#818CF8" strokeWidth="6" strokeLinecap="round" className="dark:stroke-indigo-500" />
    <path d="M50 130H90" stroke="#818CF8" strokeWidth="6" strokeLinecap="round" className="dark:stroke-indigo-500" />
    <circle cx="150" cy="130" r="16" fill="#4F46E5" />
    <path d="M144 130L148 134L156 126" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function commentFromApi(comment: ArtifactCommentDTO): TaskComment {
  return { id: comment.id, text: comment.body, timestamp: new Date(comment.createdAt).toISOString(), author: comment.author, urgent: comment.urgent, resolvedAt: comment.resolvedAt, kind: comment.kind, subject: comment.subject, annotation: comment.annotation };
}

const MarkdownCode = ({ inline, className, children, ...props }: any) => {
  const match = /language-(\w+)/.exec(className || '');
  if (!inline && match) {
    return (
      <SyntaxHighlighter
        language={match[1]}
        style={vscDarkPlus}
        customStyle={{ margin: 0, borderRadius: '0.5rem', background: 'transparent' }}
        PreTag="div"
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    );
  }
  return <code className={className} {...props}>{children}</code>;
};

const PLAN_MARKDOWN_CLASS = "prose prose-sm max-w-none dark:prose-invert prose-headings:scroll-mt-4 prose-headings:text-gray-900 dark:prose-headings:text-gray-100 prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-li:text-gray-700 dark:prose-li:text-gray-300 prose-strong:text-gray-900 dark:prose-strong:text-gray-100 prose-code:rounded prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-gray-900 dark:prose-code:bg-gray-900 dark:prose-code:text-gray-100 prose-pre:border prose-pre:border-gray-200 prose-pre:bg-gray-50 prose-pre:text-gray-900 dark:prose-pre:border-gray-800 dark:prose-pre:bg-gray-950 dark:prose-pre:text-gray-100 prose-table:text-sm prose-th:border prose-th:border-gray-200 prose-th:bg-gray-50 prose-th:px-3 prose-th:py-2 prose-td:border prose-td:border-gray-200 prose-td:px-3 prose-td:py-2 dark:prose-th:border-gray-800 dark:prose-th:bg-gray-900 dark:prose-td:border-gray-800";
const PLAN_NAV_BUTTON_CLASS = "inline-flex min-h-8 items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-800 dark:text-gray-200 dark:hover:bg-gray-900 dark:focus-visible:ring-offset-gray-950";
const PLAN_DOC_TAB_BASE_CLASS = "group min-h-9 max-w-56 flex-shrink-0 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950";
const PLAN_DOC_TAB_ACTIVE_CLASS = "border-blue-300 bg-blue-50 text-blue-800 shadow-sm dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200";
const PLAN_DOC_TAB_IDLE_CLASS = "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:bg-gray-900";


export const PlanMarkdown = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { content: string }>(({ content, className = '', ...props }, ref) => (
  <article ref={ref} className={`${PLAN_MARKDOWN_CLASS} ${className}`.trim()} {...props}>
    <Markdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>{content}</Markdown>
  </article>
));
PlanMarkdown.displayName = 'PlanMarkdown';

export function PlanMarkdownLoading() {
  return (
    <div className="flex h-full min-h-[22rem] flex-col p-6" aria-busy="true" aria-live="polite" role="status">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-blue-100 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/60 dark:text-blue-300">
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

export const TaskDetail = () => {
  const { tasks, selectedTaskId, updateTask, isChatOpen, setIsChatOpen, addTaskComment, agents, commentEvents, resolvedCommentEvents, showToast } = useTaskContext();
  const { theme, toggleTheme } = useTheme();
  const [newCriteriaText, setNewCriteriaText] = React.useState('');
  const [isAddingCriteria, setIsAddingCriteria] = React.useState(false);
  const [newDecisionText, setNewDecisionText] = React.useState('');
  const [newRelationshipText, setNewRelationshipText] = React.useState('');
  const [commentText, setCommentText] = React.useState('');
  const [showProperties, setShowProperties] = React.useState(false);
  const [expandedContext, setExpandedContext] = React.useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = React.useState<string | null>(null);
  const [pipeline, setPipeline] = React.useState<PipelinePayload | null>(null);
  const [comments, setComments] = React.useState<TaskComment[]>([]);

  const [annotationText, setAnnotationText] = React.useState('');
  const [annotationDraft, setAnnotationDraft] = React.useState<AnnotationDraft | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = React.useState<string | null>(null);
  const [sendingAnnotationId, setSendingAnnotationId] = React.useState<string | null>(null);
  const [targetAgentByAnnotation, setTargetAgentByAnnotation] = React.useState<Record<string, string>>({});
  const [mainPanePercent, setMainPanePercent] = React.useState(() => clamp(storedNumber('omp.taskDetail.mainPanePercent', 48), 30, 72));
  const splitContainerRef = React.useRef<HTMLDivElement | null>(null);
  const planArticleRef = React.useRef<HTMLElement | null>(null);
  const planScrollRef = React.useRef<HTMLDivElement | null>(null);
  const annotationTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const task = tasks.find(t => t.id === selectedTaskId);

  const selectedPlanDoc = React.useMemo(() => {
    const docs = pipeline?.documents ?? [];
    return docs.find((item) => item.path === selectedDoc) ?? docs[0] ?? null;
  }, [pipeline, selectedDoc]);

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
  const selectedDocAnnotations = React.useMemo(() => {
    if (!selectedPlanDoc) return [];
    return planAnnotations.filter((comment) => comment.annotation?.planPath === selectedPlanDoc.path);
  }, [planAnnotations, selectedPlanDoc]);


  React.useEffect(() => {
    setPipeline(null);
    setComments(task?.comments ?? []);
    setSelectedDoc(null);
    if (!task || !featureId || !repo) return;
    void apiJson<PipelinePayload>(`/api/features/${encodeURIComponent(featureId)}/pipeline?repo=${encodeURIComponent(repo)}`)
      .then((payload) => {
        setPipeline(payload);
        setSelectedDoc(preferredPlanDoc(payload.documents)?.path ?? null);
        if (payload.comments.length) setComments(payload.comments.map(commentFromApi));
      })
      .catch(() => undefined);
  }, [task?.id, featureId, repo, preferredPlanDoc]);

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
      body: JSON.stringify({ planPath: selectedPlanDoc.path, body: annotationText.trim(), quote, lineStart: annotationDraft.lineStart, lineEnd: annotationDraft.lineEnd }),
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
              <div className="flex min-h-10 items-center gap-2 rounded border border-dashed border-blue-200 bg-blue-50/60 p-3 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300" aria-busy="true" role="status">
                <FileText className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                Loading plan documents
              </div>
            ) : docs.length === 0 ? (
              <div className="rounded border border-dashed border-gray-200 dark:border-gray-800 p-3 text-sm text-gray-500 dark:text-gray-400">No plan documents found.</div>
            ) : docs.map((item) => (
              <button key={item.path} onClick={() => selectPlanDoc(item.path)} className={`flex min-h-10 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950 ${selectedPlanDoc?.path === item.path ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'}`}>
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
              <div className="flex shrink-0 items-center gap-2" aria-label="Plan document navigation">
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
            </div>
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
                        <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${active ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200' : 'bg-gray-100 text-gray-500 group-hover:text-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:group-hover:text-gray-200'}`}>{index + 1}</span>
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
                  <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">Annotate selection</div>
                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {annotationDraft.lineStart ? `Line ${annotationDraft.lineStart}${annotationDraft.lineEnd && annotationDraft.lineEnd !== annotationDraft.lineStart ? `-${annotationDraft.lineEnd}` : ''}` : 'Selected markdown text'}
                  </div>
                </div>
                <button type="button" onClick={() => setAnnotationDraft(null)} className="flex min-h-10 w-10 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-900 dark:hover:text-gray-200" aria-label="Close annotation popover">
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <blockquote className="mb-2 max-h-24 overflow-auto rounded border-l-4 border-blue-400 bg-blue-50 p-2 text-xs text-gray-700 dark:bg-blue-950/30 dark:text-gray-300">{annotationDraft.quote}</blockquote>
              <label htmlFor="plan-annotation-body" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">What should change?</label>
              <textarea
                ref={annotationTextareaRef}
                id="plan-annotation-body"
                value={annotationText}
                onChange={(event) => setAnnotationText(event.target.value)}
                placeholder="Leave a note for collaborators or a planner agent."
                className="min-h-24 w-full resize-none rounded-md border border-gray-200 bg-white p-2 text-sm text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="submit" disabled={!annotationText.trim()} className="min-h-10 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-gray-950">Save</button>
                <button type="button" disabled={!annotationText.trim()} onClick={() => void saveAnnotation(true)} className="min-h-10 rounded-md border border-blue-300 px-3 py-2 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950 dark:focus-visible:ring-offset-gray-950">Save + planner</button>
              </div>
            </form>
          )}
          <PlanMarkdown
            ref={planArticleRef}
            content={selectedPlanDoc.content}
            onMouseUp={() => window.setTimeout(captureSelection, 0)}
            onKeyUp={captureSelection}
          />
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
                <div id={`annotation-${annotation.id}`} key={annotation.id} className={`rounded-lg border p-3 transition-colors ${annotation.resolvedAt ? 'border-gray-200 bg-gray-50 opacity-70 dark:border-gray-800 dark:bg-gray-900/40' : activeAnnotationId === annotation.id ? 'ring-2 ring-blue-500' : ''}`} style={!annotation.resolvedAt ? { borderColor: colors.border, backgroundColor: colors.card } : undefined}>
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: colors.border }} />
                      <span className="truncate">{annotation.author ?? 'User'} · {new Date(annotation.timestamp).toLocaleString()}{annotation.annotation?.lineStart ? ` · line ${annotation.annotation.lineStart}${annotation.annotation.lineEnd && annotation.annotation.lineEnd !== annotation.annotation.lineStart ? `-${annotation.annotation.lineEnd}` : ''}` : ''}</span>
                    </div>
                    {annotation.resolvedAt ? <span className="text-xs text-gray-400">Resolved</span> : <button onClick={() => void resolveAnnotation(annotation)} className="min-h-10 rounded px-2 text-xs text-gray-500 hover:bg-white focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-900">Resolve</button>}
                  </div>
                  {annotation.annotation?.quote && <blockquote className="mb-2 rounded border-l-4 bg-white/70 p-2 text-xs text-gray-700 dark:bg-gray-950/60 dark:text-gray-300" style={{ borderColor: colors.border }}>{annotation.annotation.quote}</blockquote>}
                  <p className="whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200">{annotation.text}</p>
                  {!annotation.resolvedAt && <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button disabled={sendingAnnotationId === annotation.id} onClick={() => void sendAnnotation(annotation, 'planner')} className="min-h-10 rounded-md bg-gray-900 px-3 py-2 text-xs font-medium text-white focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">Send to planner</button>
                    {activeAgents.length > 0 && (
                      <>
                        <select value={targetAgentByAnnotation[annotation.id] ?? ''} onChange={(event) => setTargetAgentByAnnotation((prev) => ({ ...prev, [annotation.id]: event.target.value }))} className="min-h-10 rounded-md border border-gray-200 bg-white px-2 text-xs focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200">
                          <option value="">Pick agent</option>
                          {activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                        </select>
                        <button disabled={sendingAnnotationId === annotation.id} onClick={() => void sendAnnotation(annotation, 'agent')} className="min-h-10 rounded-md border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:border-gray-800 dark:text-gray-300">Send to agent</button>
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
        <button className="min-h-8 rounded-md px-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 text-xs flex items-center gap-1 focus-visible:ring-2 focus-visible:ring-blue-500"><Search className="w-3.5 h-3.5" /> Jump <span className="bg-gray-100 dark:bg-gray-800 px-1 rounded border border-gray-200 dark:border-gray-700 text-[10px]">⌘K</span></button>
        <button onClick={toggleTheme} className="flex min-h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500" title="Toggle theme" aria-label="Toggle theme">{theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}</button>
        <button onClick={() => setIsChatOpen(!isChatOpen)} className={`flex min-h-8 items-center gap-1.5 px-2.5 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${isChatOpen ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`}><Bot className="w-3.5 h-3.5" /> Agent</button>
      </div>

      {!task ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 p-8 text-center bg-gray-50/30 dark:bg-gray-900/30 transition-colors duration-200">
          <EmptyStateIllustration />
          <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">No task selected</h2>
          <p className="text-sm max-w-sm">Select a task from the list on the left to view its details, properties, and criteria.</p>
        </div>
      ) : (
        <div
          ref={splitContainerRef}
          className="flex-1 overflow-hidden flex flex-col lg:flex-row"
          style={{ '--detail-pane-width': `${mainPanePercent}%` } as React.CSSProperties}
        >
          <section className="min-w-0 flex-1 overflow-y-auto scrollbar-custom lg:flex-none lg:[flex-basis:var(--detail-pane-width)]">
            <div className="mx-auto max-w-3xl px-4 py-5 lg:px-5">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-xs mb-2"><span className="font-medium text-gray-700 dark:text-gray-300">{task.id}</span><ChevronRight className="w-3 h-3" /><span>{task.properties.project.name}</span></div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowProperties(!showProperties)} className={`w-7 h-7 rounded border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 flex items-center justify-center transition-colors ${showProperties ? 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200' : 'text-gray-400'}`} title="Toggle Properties"><PanelRight className="w-3.5 h-3.5" /></button>
                  <button className="w-7 h-7 rounded border border-gray-200 dark:border-gray-800 text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900 flex items-center justify-center transition-colors"><Copy className="w-3.5 h-3.5" /></button>
                </div>
              </div>

              <input key={`${task.id}:title`} className="w-full rounded text-2xl font-bold text-gray-900 dark:text-gray-100 mb-5 outline-none leading-tight bg-transparent focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950" defaultValue={task.title} onBlur={(e) => e.currentTarget.value !== task.title && updateTask(task.id, { title: e.currentTarget.value })} />

              <div className="mb-5 grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-400 sm:grid-cols-3">
                <div><div className="font-semibold uppercase tracking-widest text-gray-400">Status</div><div className="mt-1 font-medium text-gray-900 dark:text-gray-100">{task.properties.status}</div></div>
                <div><div className="font-semibold uppercase tracking-widest text-gray-400">Plan created</div><div className="mt-1">{formatWhen(task.properties.createdAt ?? pipeline?.feature?.createdAt)}</div></div>
                <div><div className="font-semibold uppercase tracking-widest text-gray-400">Plan updated</div><div className="mt-1">{formatWhen(task.properties.updatedAt ?? pipeline?.feature?.updatedAt)}</div></div>
              </div>

              {!overviewDoc && (
                <div className="mb-10">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-100 dark:border-gray-800 pb-2">Description</div>
                  <textarea key={`${task.id}:description`} className="w-full min-h-32 text-gray-700 dark:text-gray-300 leading-relaxed text-[15px] whitespace-pre-wrap bg-transparent border border-transparent hover:border-gray-200 dark:hover:border-gray-800 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 rounded p-2 outline-none" defaultValue={task.description} onBlur={(e) => e.currentTarget.value !== task.description && updateTask(task.id, { description: e.currentTarget.value })} placeholder="Describe what the agent needs to do and why." />
                </div>
              )}

              <div className="mb-7">
                <div className="flex items-center justify-between mb-3 border-b border-gray-100 dark:border-gray-800 pb-2">
                  <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest flex items-center gap-2">Acceptance Criteria <span className="text-gray-500 font-medium">{task.acceptanceCriteria.filter(c => c.completed).length} / {task.acceptanceCriteria.length}</span></div>
                  <button onClick={() => setIsAddingCriteria(true)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs font-medium flex items-center gap-1 transition-colors"><Plus className="w-3 h-3" /> Add</button>
                </div>
                <div className="space-y-1.5">
                  {task.acceptanceCriteria.length === 0 && !isAddingCriteria ? <div className="text-gray-400 dark:text-gray-500 italic text-sm py-2">No acceptance criteria defined.</div> : task.acceptanceCriteria.map(criteria => (
                    <div key={criteria.id} className="group flex items-start gap-3 p-3 border border-gray-200 dark:border-gray-800 rounded-lg hover:border-gray-300 dark:hover:border-gray-700 bg-white dark:bg-gray-900 transition-colors">
                      <input type="checkbox" checked={criteria.completed} onChange={() => handleToggleCriteria(criteria.id)} className="mt-1 w-4 h-4 text-blue-600 rounded border-gray-300 dark:border-gray-700 focus:ring-blue-500 bg-transparent cursor-pointer" />
                      <div className={`flex-1 text-sm leading-snug ${criteria.completed ? 'text-gray-400 line-through' : 'text-gray-700 dark:text-gray-300'}`}>{criteria.text}</div>
                      <button onClick={() => handleDeleteCriteria(criteria.id)} className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all rounded hover:bg-red-50 dark:hover:bg-red-900/30"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                  {isAddingCriteria && <div className="flex items-start gap-3 p-3 border border-blue-300 dark:border-blue-700 rounded-lg bg-blue-50/30 dark:bg-blue-900/10"><input type="checkbox" disabled className="mt-1 w-4 h-4 text-gray-300 rounded border-gray-200 bg-transparent" /><input autoFocus type="text" value={newCriteriaText} onChange={(e) => setNewCriteriaText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAddCriteria(); if (e.key === 'Escape') setIsAddingCriteria(false); }} placeholder="Add acceptance criteria..." className="flex-1 bg-transparent border-none outline-none text-sm w-full dark:text-gray-200" /><button onClick={handleAddCriteria} className="text-xs px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded font-medium transition-colors">Save</button></div>}
                </div>
              </div>

              <div className="mb-7">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-100 dark:border-gray-800 pb-2 flex items-center gap-2">Context Bundle From Plan <span className="px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 lowercase font-normal">agent input</span></div>
                <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden bg-white dark:bg-gray-900 transition-colors">
                  <div className="px-3 py-2 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300"><Box className="w-4 h-4 text-blue-500" /> planning bundle</div><span className="text-[10px] font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700">MD</span></div>
                  <div className="h-0.5 bg-blue-600 w-full"></div>
                  {(['spec', 'criteria', 'prerequisites', 'decisions', 'downstream'] as const).map((key) => (
                    <button key={key} onClick={() => setExpandedContext(expandedContext === key ? null : key)} className="w-full flex min-h-10 items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors border-b border-gray-100 dark:border-gray-800 last:border-b-0 focus-visible:ring-2 focus-visible:ring-blue-500">
                      <div className="grid min-w-0 flex-1 grid-cols-[0.25rem_6.5rem_minmax(0,1fr)] items-center gap-3 text-left"><div className="h-4 w-1 bg-blue-400 rounded-full"></div><span className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase">{key}</span><span className="truncate text-sm text-gray-800 dark:text-gray-200">{task.contextBundle[key]}</span></div><ChevronRight className={`w-4 h-4 flex-shrink-0 text-gray-400 transition-transform ${expandedContext === key ? 'rotate-90' : ''}`} />
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

              <div className="mb-6 pb-6">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest flex items-center gap-2 mb-4 border-b border-gray-100 dark:border-gray-800 pb-2">Comments <span className="text-gray-500 font-medium">{regularComments.length}</span></div>
                <div className="space-y-4">{regularComments.map(comment => <div key={comment.id} className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-lg border border-gray-100 dark:border-gray-800 transition-colors"><div className="flex items-center justify-between mb-2"><span className="text-xs font-medium text-gray-700 dark:text-gray-300">{comment.author ?? 'User'}</span><span className="text-xs text-gray-400">{new Date(comment.timestamp).toLocaleString()}</span></div><p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{comment.text}</p></div>)}</div>
                <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-400 transition-all"><textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Add an instruction/comment for agents working this task..." className="w-full p-3 bg-white dark:bg-gray-900 text-sm text-gray-700 dark:text-gray-200 focus:outline-none min-h-[80px] resize-none" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitComment(); }} /><div className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center text-xs"><span className="text-gray-400">Saved comments are included in feature workflow prompts.</span><button onClick={() => void submitComment()} className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded font-medium transition-colors">Comment</button></div></div>
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
            className="group hidden w-2 flex-shrink-0 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-blue-500/15 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-blue-400/15 lg:flex"
            title="Drag to resize panes. Double-click to reset."
          >
            <span className="h-10 w-px rounded-full bg-gray-300 transition-colors group-hover:bg-blue-500 dark:bg-gray-700 dark:group-hover:bg-blue-400" aria-hidden="true" />
          </div>
          <aside className="flex min-h-[22rem] min-w-0 flex-1 flex-col border-t border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-950/60 lg:min-h-0 lg:border-l lg:border-t-0">
            {renderPlanDocPane()}
          </aside>
          {showProperties && <TaskProperties task={task} />}
        </div>
      )}
    </main>
  );
};
