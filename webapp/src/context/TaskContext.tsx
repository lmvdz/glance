import React, { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { Task, Project, TaskComment } from '../types';
import { jsonInit, apiJson } from '../lib/api';
import { projectsByTeam, tasksFromSquad } from '../lib/task-model';
import { useSquad } from '../hooks/useSquad';
import type { AgentDTO, ArtifactCommentDTO, CapabilitySnapshotDTO, ClientCommand, PublicCapabilityCatalogDTO, TranscriptEntry } from '../lib/dto';

export interface ToastInfo {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

export type AppView = 'tasks' | 'capabilities' | 'automation' | 'fleet-health' | 'heat' | 'federation';
export type TaskFilter = 'open' | 'active' | 'done' | 'all';

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
  transcripts: Map<string, TranscriptEntry[]>;
  capabilities: CapabilitySnapshotDTO;
  publicCatalog: PublicCapabilityCatalogDTO[];
  selectedTaskId: string | null;
  toasts: ToastInfo[];
  view: AppView;
  taskFilter: TaskFilter;
  isChatOpen: boolean;
  reload: () => Promise<void>;
  setView: (view: AppView) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setIsChatOpen: (isOpen: boolean) => void;
  selectTask: (id: string | null) => void;
  addTask: (task: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  toggleTaskComplete: (id: string) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  reorderTasks: (startIndex: number, endIndex: number) => void;
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
  const [view, setView] = useState<AppView>('tasks');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('open');
  const [isChatOpen, setIsChatOpen] = useState(false);

  useEffect(() => {
    const nextSelectedTaskId = reconcileSelectedTaskId(selectedTaskId, tasks);
    if (nextSelectedTaskId !== selectedTaskId) setSelectedTaskId(nextSelectedTaskId);
  }, [tasks, selectedTaskId]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const currentProject = selectedTask?.properties.project ?? Object.values(projects)[0]?.[0] ?? null;

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  const reorderTasks = (_startIndex: number, _endIndex: number) => {
    showToast('Live omp-squad ordering is driven by the daemon', 'info');
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

  const deleteTask = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    const featureId = task?.sourceId ?? id;
    void apiJson(`/api/features/${encodeURIComponent(featureId)}`, jsonInit('PATCH', { repo: task?.properties.project.id, archived: true }))
      .then(() => squad.reload())
      .then(() => showToast(`Feature archived: ${id}`))
      .catch((error: Error) => showToast(error.message || 'Could not archive feature', 'error'));
  };

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
    <TaskContext.Provider value={{ tasks, agents: squad.agents, projects, currentProject, capabilities: squad.capabilities, publicCatalog: squad.publicCatalog, connected: squad.connected, transcripts: squad.transcripts, commentEvents: squad.commentEvents, resolvedCommentEvents: squad.resolvedCommentEvents, selectedTaskId, toasts, view, taskFilter, isChatOpen, reload: squad.reload, setView, setTaskFilter, setIsChatOpen, selectTask, addTask, deleteTask, toggleTaskComplete, updateTask, reorderTasks, showToast, sendConsoleCommand: squad.send, subscribeConsole: squad.subscribe, installCapability, importCatalogCapability, setCapabilityEnabled, runCapability, addTaskComment, loadTaskComments }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTaskContext() {
  const context = useContext(TaskContext);
  if (!context) throw new Error('useTaskContext must be used within TaskProvider');
  return context;
}
