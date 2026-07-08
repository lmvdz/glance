import React, { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { Task, Project, TaskComment } from '../types';
import { jsonInit, apiJson } from '../lib/api';
import { projectsByTeam, tasksFromSquad } from '../lib/task-model';
import { useSquad } from '../hooks/useSquad';
import type { AgentDTO, ArtifactCommentDTO, AuditEntry, CapabilitySnapshotDTO, ClientCommand, FeatureDTO, PublicCapabilityCatalogDTO, TranscriptEntry } from '../lib/dto';

export interface ToastInfo {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

export type AppView = 'attention' | 'active' | 'cockpit' | 'tasks' | 'capabilities' | 'automation' | 'fleet-health' | 'heat' | 'activity-heatmap' | 'omp-graph' | 'scoreboard' | 'topology' | 'federation' | 'knowledge' | 'org' | 'intervene';
export type TaskFilter = 'open' | 'active' | 'done' | 'all';

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
  /** The agent that was most recently opened via openConsole(). AssistantChat reacts to switch its active session. */
  openedConsoleAgentId: string | null;
  /** The agent the Intervene View is focused on (set by openIntervene). */
  interveneAgentId: string | null;
  reload: () => Promise<void>;
  setView: (view: AppView) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setIsChatOpen: (isOpen: boolean) => void;
  /** Subscribe to an agent's transcript AND open the chat panel focused on that agent. No-op if agentId is undefined. */
  openConsole: (agentId: string | undefined) => void;
  /** Focus the full-screen Intervene View on an agent (subscribe + route). The step-in surface off a "Needs you" tap. */
  openIntervene: (agentId: string | undefined) => void;
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
  const [view, setView] = useState<AppView>('attention');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('open');
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [openedConsoleAgentId, setOpenedConsoleAgentId] = useState<string | null>(null);
  const [interveneAgentId, setInterveneAgentId] = useState<string | null>(null);
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
    <TaskContext.Provider value={{ tasks, agents: squad.agents, features: squad.features, audit, projects, currentProject, capabilities: squad.capabilities, publicCatalog: squad.publicCatalog, connected: squad.connected, transcripts: squad.transcripts, commentEvents: squad.commentEvents, resolvedCommentEvents: squad.resolvedCommentEvents, selectedTaskId, toasts, view, taskFilter, isChatOpen, openedConsoleAgentId, interveneAgentId, reload: squad.reload, setView, setTaskFilter, setIsChatOpen, openConsole, openIntervene, selectTask, addTask, deleteTask, restoreFeature, hardDeleteFeature, loadArchivedFeatures, toggleTaskComplete, updateTask, showToast, sendConsoleCommand: squad.send, subscribeConsole: squad.subscribe, installCapability, importCatalogCapability, setCapabilityEnabled, runCapability, addTaskComment, loadTaskComments }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTaskContext() {
  const context = useContext(TaskContext);
  if (!context) throw new Error('useTaskContext must be used within TaskProvider');
  return context;
}
