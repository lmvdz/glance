import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { Task, Project, TaskComment } from '../types';
import { jsonInit, apiJson } from '../lib/api';
import { projectsByTeam, tasksFromSquad } from '../lib/task-model';
import { buildReviewHash, parseReviewHash } from '../lib/plan-doc-review';
import { useSquad } from '../hooks/useSquad';
import { coerceView, VIEW_STORAGE_KEY } from '../lib/viewAlias';
import type { AgentDTO, ArtifactCommentDTO, AuditEntry, CapabilitySnapshotDTO, ClientCommand, FeatureDTO, PublicCapabilityCatalogDTO, TranscriptEntry } from '../lib/dto';

export interface ToastInfo {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

/**
 * The four-item shell (GRAPH-FOLD.md §6e) + the views reached BY ROUTING INTO them rather than
 * from the top-level rail: `org` (the AccountMenu gear), `intervene` (a "Needs you" tap),
 * `review` (a design-review deep link). The eight retired keys (attention/active/cockpit/
 * automation/fleet-health/heat/activity-heatmap/scoreboard/topology/federation/knowledge) are
 * GONE from this union on purpose — any stale value (e.g. a pre-fold localStorage `view`) is
 * coerced through `lib/viewAlias.ts` BEFORE it ever becomes state, so nothing outside this file
 * can construct an AppView the render switch doesn't handle.
 */
export type AppView = 'fleet' | 'tasks' | 'omp-graph' | 'capabilities' | 'org' | 'intervene' | 'review';
export type TaskFilter = 'open' | 'active' | 'done' | 'all';

/** Read the raw persisted view key (pre-coercion) — a plain function so both the `view` and
 *  `isCommandPaletteOpen` lazy initializers read the SAME localStorage value without a second
 *  `coerceView` call disagreeing (there's only one read; window/SSR-guarded). */
function readStoredView(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(VIEW_STORAGE_KEY);
}

/** One soft-deleted feature in the "garbage bin" (GET /api/features/archived). */
export interface ArchivedFeature {
  id: string;
  title: string;
  repo: string;
  planDir?: string;
  moduleUrl?: string;
  updatedAt: number;
}

interface ApiComment {
  id: string;
  repo: string;
  subject: string;
  body: string;
  author: string;
  createdAt: number;
  urgent?: boolean;
  resolvedAt?: number;
  kind?: "comment" | "plan-annotation";
  annotation?: { planPath: string; lineStart?: number; lineEnd?: number; quote?: string };
}

interface TaskContextType {
  tasks: Task[];
  projects: Record<string, Project[]>;
  currentProject: Project | null;
  commentEvents: ArtifactCommentDTO[];
  resolvedCommentEvents: Map<string, number>;
  connected: boolean;
  agents: AgentDTO[];
  /** Raw live feature/plan list — the other half of the active-work join (agents being the first). */
  features: FeatureDTO[];
  /** Recent fleet audit trail (newest-first) — the narrative source for "what the fleet just did". */
  audit: AuditEntry[];
  transcripts: Map<string, TranscriptEntry[]>;
  capabilities: CapabilitySnapshotDTO;
  publicCatalog: PublicCapabilityCatalogDTO[];
  selectedTaskId: string | null;
  toasts: ToastInfo[];
  view: AppView;
  taskFilter: TaskFilter;
  isChatOpen: boolean;
  /** ⌘K palette (GRAPH-FOLD.md §3) — open everywhere, not scoped to a view. */
  isCommandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;
  /** The agent that was most recently opened via openConsole(). AssistantChat reacts to switch its active session. */
  openedConsoleAgentId: string | null;
  /** The agent the Intervene View is focused on (set by openIntervene). */
  interveneAgentId: string | null;
  /** The task (feature) the Design Review screen is focused on (set by openReview). Mirrors the
   *  deep-linkable `#/review/:taskId[?doc=...]` hash so a refresh/share lands on the same review. */
  reviewTaskId: string | null;
  /** The specific plan-doc path being reviewed, when the caller named one (else the feature's first doc). */
  reviewDocPath: string | undefined;
  reload: () => Promise<void>;
  setView: (view: AppView) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setIsChatOpen: (isOpen: boolean) => void;
  /** Subscribe to an agent's transcript AND open the chat panel focused on that agent. No-op if agentId is undefined. */
  openConsole: (agentId: string | undefined) => void;
  /** Focus the full-screen Intervene View on an agent (subscribe + route). The step-in surface off a "Needs you" tap. */
  openIntervene: (agentId: string | undefined) => void;
  /** Route to the design-review screen for one task's plan doc (`/review/:taskId`). */
  openReview: (taskId: string, docPath?: string) => void;
  /** Leave the Design Review screen back to Tasks (keeps the task selected, so TaskDetail resumes). */
  closeReview: () => void;
  selectTask: (id: string | null) => void;
  addTask: (task: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  restoreFeature: (id: string, repo?: string) => Promise<void>;
  hardDeleteFeature: (id: string, opts?: { repo?: string; plane?: 'keep' | 'detach' }) => Promise<void>;
  loadArchivedFeatures: (repo?: string) => Promise<ArchivedFeature[]>;
  toggleTaskComplete: (id: string) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  sendConsoleCommand: (command: ClientCommand) => void;
  subscribeConsole: (id: string) => void;
  installCapability: (packId: string) => void;
  importCatalogCapability: (catalogId: string) => void;
  setCapabilityEnabled: (installId: string, enabled: boolean) => void;
  runCapability: (installId: string, bindingKey?: string) => void;
  addTaskComment: (id: string, text: string, urgent?: boolean) => Promise<TaskComment | null>;
  loadTaskComments: (id: string) => Promise<TaskComment[]>;
}

const TaskContext = createContext<TaskContextType | undefined>(undefined);

function stageForStatus(status: Task['status']): 'planned' | 'in-progress' | 'done' {
  if (status === 'done') return 'done';
  if (status === 'active') return 'in-progress';
  return 'planned';
}

function apiCommentToTask(comment: ApiComment): TaskComment {
  return { id: comment.id, text: comment.body, timestamp: new Date(comment.createdAt).toISOString(), author: comment.author, urgent: comment.urgent, resolvedAt: comment.resolvedAt, kind: comment.kind, subject: comment.subject, annotation: comment.annotation };
}

export function reconcileSelectedTaskId(selectedTaskId: string | null, tasks: Pick<Task, 'id'>[]): string | null {
  if (!selectedTaskId) return null;
  return tasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : null;
}

export function TaskProvider({ children }: { children: ReactNode }) {
  const squad = useSquad();
  const baseTasks = useMemo(() => tasksFromSquad(squad.features, squad.agents, squad.projects), [squad.features, squad.agents, squad.projects]);
  const [localEdits, setLocalEdits] = useState<Record<string, Partial<Task>>>({});
  const tasks = useMemo(() => baseTasks.map((task) => ({ ...task, ...localEdits[task.id] })), [baseTasks, localEdits]);
  const projects = useMemo(() => projectsByTeam(squad.projects, squad.features), [squad.projects, squad.features]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastInfo[]>([]);
  // Restore + coerce the persisted view in one lazy read (GRAPH-FOLD.md §3 alias/redirect map) —
  // a stale pre-fold key (or garbage) never reaches state as anything but a real AppView.
  const [view, setViewState] = useState<AppView>(() => coerceView(readStoredView()).view);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(() => coerceView(readStoredView()).openPalette);
  // Taste-review nit 3: `openPalette` is true for exactly one coercion — a stale `knowledge` key
  // (see viewAlias.ts) — so it doubles as "did THIS boot teleport here from the dead Knowledge
  // page". Captured once at mount (like the two reads above) so the one-time toast below never
  // re-derives it from a localStorage read that the normalization effect has since overwritten.
  const [bootCoercedFromKnowledge] = useState<boolean>(() => coerceView(readStoredView()).openPalette);
  // Belt-and-suspenders against StrictMode's dev-mode double-invoke of mount effects (verified
  // live: without this, the toast below fired twice on one real page load) — a ref survives the
  // synthetic unmount/remount cycle StrictMode runs on the SAME component instance, so it still
  // gates a genuine single boot to exactly one toast.
  const knowledgeToastFiredRef = useRef(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('open');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [openedConsoleAgentId, setOpenedConsoleAgentId] = useState<string | null>(null);
  const [interveneAgentId, setInterveneAgentId] = useState<string | null>(null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [reviewDocPath, setReviewDocPath] = useState<string | undefined>(undefined);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  useEffect(() => {
    const nextSelectedTaskId = reconcileSelectedTaskId(selectedTaskId, tasks);
    if (nextSelectedTaskId !== selectedTaskId) setSelectedTaskId(nextSelectedTaskId);
  }, [tasks, selectedTaskId]);

  // The fleet narrative isn't on the WS snapshot — poll the append-only audit log. Shared here so
  // the Active Work pane and the assistant both narrate "what just happened" from one source.
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiJson<AuditEntry[] | { entries?: AuditEntry[] }>('/api/audit?limit=80')
        .then((r) => { if (alive) setAudit(Array.isArray(r) ? r : r?.entries ?? []); })
        .catch(() => { /* daemon offline / not yet up — keep the last good list */ });
    void load();
    const interval = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const currentProject = selectedTask?.properties.project ?? Object.values(projects)[0]?.[0] ?? null;

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  const openConsole = (agentId: string | undefined) => {
    if (!agentId) return;
    squad.subscribe(agentId);
    setOpenedConsoleAgentId(agentId);
    setIsChatOpen(true);
  };

  // Step into one agent full-screen: subscribe to its transcript (so the diff/console are warm)
  // and route to the Intervene View. The primary target of a "Needs you" tap.
  const openIntervene = (agentId: string | undefined) => {
    if (!agentId) return;
    squad.subscribe(agentId);
    setInterveneAgentId(agentId);
    setView('intervene');
  };

  // Design Review has no react-router (this SPA doesn't use one anywhere), but the reference
  // treats it as a real route — so it's deep-linkable via a `#/review/:taskId[?doc=...]` hash,
  // synced both ways: openReview/closeReview write the hash, and a hashchange listener (below)
  // restores the view on a fresh load or back/forward navigation.
  const openReview = (taskId: string, docPath?: string) => {
    setReviewTaskId(taskId);
    setReviewDocPath(docPath);
    setView('review');
    window.location.hash = buildReviewHash({ taskId, docPath });
  };

  const closeReview = () => {
    setView('tasks');
    if (window.location.hash.startsWith('#/review/')) history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  useEffect(() => {
    const applyHash = () => {
      const parsed = parseReviewHash(window.location.hash);
      if (!parsed) return;
      setReviewTaskId(parsed.taskId);
      setReviewDocPath(parsed.docPath);
      setView('review');
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // The only mutator of `view` state — persists every navigation to localStorage so a reload
  // restores the same screen. TypeScript already guarantees `next` is a live AppView (the dead
  // keys aren't in the union), so this never needs to re-run it through coerceView; only the
  // localStorage RESTORE path (above) reads a value that could be stale.
  const setView = useCallback((next: AppView) => {
    setViewState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }, []);

  const openCommandPalette = useCallback(() => setIsCommandPaletteOpen(true), []);
  const closeCommandPalette = useCallback(() => setIsCommandPaletteOpen(false), []);
  const toggleCommandPalette = useCallback(() => setIsCommandPaletteOpen((open) => !open), []);

  // Normalize the persisted key once per boot: after a dead key was coerced (heat → omp-graph,
  // knowledge → omp-graph + palette, …) write the LIVE key back so the alias only fires once —
  // otherwise a stale `knowledge` would re-open the palette on every reload forever.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(VIEW_STORAGE_KEY) !== view) window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    // Taste-review nit 3: the `knowledge` coercion lands on Graph with the palette already open
    // but empty — silent unless you know why. One toast, once (bootCoercedFromKnowledge is fixed
    // at mount, and the write above retires the `knowledge` key so a reload never re-fires it).
    if (bootCoercedFromKnowledge && !knowledgeToastFiredRef.current) {
      knowledgeToastFiredRef.current = true;
      showToast('Knowledge base is now ⌘K — search opens in the command palette.', 'info');
    }
    // Mount-only: `view` here is the already-coerced initial state; later writes go through setView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTask = (id: string | null) => setSelectedTaskId(id);

  const addTask = (partialTask: Partial<Task>) => {
    const title = partialTask.title?.trim() || 'New Task';
    const repo = currentProject?.id || squad.projects[0]?.repo;
    void apiJson('/api/features', jsonInit('POST', { title, repo }))
      .then(() => squad.reload())
      .then(() => showToast(`Feature created: ${title}`))
      .catch((error: Error) => showToast(error.message || 'Could not create feature', 'error'));
  };

  // Archive = reversible: flips the flag AND (server-side) moves plans/<x>/ → plans/.archive/<x>/.
  const deleteTask = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    const featureId = task?.sourceId ?? id;
    void apiJson(`/api/features/${encodeURIComponent(featureId)}`, jsonInit('PATCH', { repo: task?.properties.project.id, archived: true }))
      .then(() => squad.reload())
      .then(() => showToast(`Archived ${id} — restorable from Archived`))
      .catch((error: Error) => showToast(error.message || 'Could not archive feature', 'error'));
  };

  // Restore an archived feature (un-flag + move the plan dir back out of .archive).
  const restoreFeature = (id: string, repo?: string) =>
    apiJson(`/api/features/${encodeURIComponent(id)}`, jsonInit('PATCH', { repo, archived: false }))
      .then(() => squad.reload())
      .then(() => showToast(`Restored ${id}`))
      .catch((error: Error) => showToast(error.message || 'Could not restore feature', 'error'));

  // Hard delete = permanent: removes the feature + its plan dir. `plane: "detach"` also drops the
  // Plane module grouping (issues untouched). Destructive; callers confirm first.
  const hardDeleteFeature = (id: string, opts: { repo?: string; plane?: 'keep' | 'detach' } = {}) => {
    const qs = new URLSearchParams();
    if (opts.repo) qs.set('repo', opts.repo);
    if (opts.plane === 'detach') qs.set('plane', 'detach');
    return apiJson(`/api/features/${encodeURIComponent(id)}${qs.toString() ? `?${qs}` : ''}`, { method: 'DELETE' })
      .then(() => squad.reload())
      .then(() => showToast(`Deleted ${id} permanently`))
      .catch((error: Error) => showToast(error.message || 'Could not delete feature', 'error'));
  };

  const loadArchivedFeatures = (repo?: string) =>
    apiJson<{ features: ArchivedFeature[] }>(`/api/features/archived${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
      .then((r) => r.features)
      .catch(() => [] as ArchivedFeature[]);

  const toggleTaskComplete = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    updateTask(id, { status: task.status === 'done' ? 'todo' : 'done' });
  };

  const updateTask = (id: string, updates: Partial<Task>) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const featureId = task.sourceId ?? id;
    setLocalEdits((previous) => ({ ...previous, [id]: { ...previous[id], ...updates } }));
    const patch: { repo: string; title?: string; stageOverride?: string; description?: string; acceptanceCriteria?: Task['acceptanceCriteria']; decisions?: Task['decisions']; relationships?: Task['relationships'] } = { repo: task.properties.project.id };
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.status) patch.stageOverride = stageForStatus(updates.status);
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.acceptanceCriteria !== undefined) patch.acceptanceCriteria = updates.acceptanceCriteria;
    if (updates.decisions !== undefined) patch.decisions = updates.decisions;
    if (updates.relationships !== undefined) patch.relationships = updates.relationships;
    if (Object.keys(patch).length <= 1) return;
    void apiJson(`/api/features/${encodeURIComponent(featureId)}`, jsonInit('PATCH', patch))
      .then(() => squad.reload())
      .then(() => showToast(`Feature updated: ${id}`))
      .catch((error: Error) => showToast(error.message || 'Could not update feature', 'error'));
  };

  const installCapability = (packId: string) => {
    void apiJson('/api/capability-installs', jsonInit('POST', { packId, enable: true }))
      .then(() => squad.reload())
      .then(() => showToast('Capability installed'))
      .catch((error: Error) => showToast(error.message || 'Could not install capability', 'error'));
  };

  const importCatalogCapability = (catalogId: string) => {
    void apiJson('/api/capability-sources', jsonInit('POST', { catalogId }))
      .then(() => squad.reload())
      .then(() => showToast('Capability imported from public catalog'))
      .catch((error: Error) => showToast(error.message || 'Could not import catalog capability', 'error'));
  };

  const setCapabilityEnabled = (installId: string, enabled: boolean) => {
    void apiJson(`/api/capability-installs/${encodeURIComponent(installId)}`, jsonInit('PATCH', { enabled }))
      .then(() => squad.reload())
      .then(() => showToast(enabled ? 'Capability enabled' : 'Capability disabled'))
      .catch((error: Error) => showToast(error.message || 'Could not update capability', 'error'));
  };

  const runCapability = (installId: string, bindingKey?: string) => {
    void apiJson(`/api/capability-installs/${encodeURIComponent(installId)}/run`, jsonInit('POST', { bindingKey }))
      .then(() => squad.reload())
      .then(() => showToast('Capability run started'))
      .catch((error: Error) => showToast(error.message || 'Could not run capability', 'error'));
  };

  const loadTaskComments = async (id: string): Promise<TaskComment[]> => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return [];
    const subject = task.sourceId ?? id;
    const repo = task.properties.project.id;
    const rows = await apiJson<ApiComment[]>(`/api/comments?repo=${encodeURIComponent(repo)}&subject=${encodeURIComponent(subject)}`).catch(() => []);
    return rows.map(apiCommentToTask);
  };

  const addTaskComment = async (id: string, text: string, urgent = false): Promise<TaskComment | null> => {
    const task = tasks.find((item) => item.id === id);
    if (!task || !text.trim()) return null;
    const subject = task.sourceId ?? id;
    const repo = task.properties.project.id;
    const saved = apiCommentToTask(await apiJson<ApiComment>('/api/comments', jsonInit('POST', { repo, subject, body: text.trim(), urgent })));
    setLocalEdits((previous) => ({
      ...previous,
      [id]: {
        ...previous[id],
        comments: [...(previous[id]?.comments ?? task.comments ?? []), saved],
      },
    }));
    showToast('Comment added to task context', 'success');
    return saved;
  };

  return (
    <TaskContext.Provider value={{ tasks, agents: squad.agents, features: squad.features, audit, projects, currentProject, capabilities: squad.capabilities, publicCatalog: squad.publicCatalog, connected: squad.connected, transcripts: squad.transcripts, commentEvents: squad.commentEvents, resolvedCommentEvents: squad.resolvedCommentEvents, selectedTaskId, toasts, view, taskFilter, isChatOpen, isCommandPaletteOpen, openCommandPalette, closeCommandPalette, toggleCommandPalette, openedConsoleAgentId, interveneAgentId, reviewTaskId, reviewDocPath, reload: squad.reload, setView, setTaskFilter, setIsChatOpen, openConsole, openIntervene, openReview, closeReview, selectTask, addTask, deleteTask, restoreFeature, hardDeleteFeature, loadArchivedFeatures, toggleTaskComplete, updateTask, showToast, sendConsoleCommand: squad.send, subscribeConsole: squad.subscribe, installCapability, importCatalogCapability, setCapabilityEnabled, runCapability, addTaskComment, loadTaskComments }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTaskContext() {
  const context = useContext(TaskContext);
  if (!context) throw new Error('useTaskContext must be used within TaskProvider');
  return context;
}
