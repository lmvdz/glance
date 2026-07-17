import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Filter,
  Inbox,
  RotateCcw,
  Layers,
  ListChecks,
  CloudFog,
  Menu,
  MessageSquareWarning,
  Mic,
  Plus,
  Search,
  Settings,
  Tag,
  Trash2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { getCategoryBadge } from '../utils';
import { useTaskContext, type AppView, type TaskFilter, type ArchivedFeature } from '../context/TaskContext';
import { summarizeTask, taskListRank, type TaskStatus } from '../lib/taskStatus';
import { taskRef } from '../lib/task-model';
import { startVoiceInput, type VoiceInputSession } from '../lib/voice/speech';
import { AccountMenu } from './AccountMenu';
import { Kbd } from './kit/Kbd';
import { MonoLabel } from './kit/MonoLabel';
import { GlanceLogo } from './GlanceLogo';
import type { Task } from '../types';

const taskFilters: Array<{ key: TaskFilter; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
];

const categories: Array<'all' | Task['category']> = ['all', 'frontend', 'backend', 'devops', 'mcp', 'database', 'other'];

/**
 * Task-rail search predicate — matches the placeholder's promise ("by title or ID"). Tests the title,
 * the internal feature id, AND `displayId` (the Plane ticket like OMPSQ-306 that `taskRef` actually
 * renders as the row's ID handle) — the old predicate omitted displayId, so typing the exact ID a user
 * sees on the row returned zero results. Exported + pure so the match rule is unit-tested.
 */
export function matchesTaskSearch(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    task.title.toLowerCase().includes(q) ||
    task.id.toLowerCase().includes(q) ||
    (task.displayId?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Task-rail sort comparator. 'attention' floats what-needs-you up via `rankFor` (lower rank first);
 * 'creation' orders by the feature's real `createdAt`, most recent first (undated sorts last). Pure +
 * exported so the ordering is unit-tested — the old comparator returned 0 for 'creation' (dead) and had
 * a 'dueDate' branch keyed on a field nothing ever populated (also dead).
 */
export function compareTaskRail(a: Task, b: Task, sortBy: 'attention' | 'creation', rankFor: (t: Task) => number): number {
  if (sortBy === 'attention') return rankFor(a) - rankFor(b);
  return (b.properties.createdAt ?? 0) - (a.properties.createdAt ?? 0);
}

/**
 * The task-scoped control block — search, the Open/Active/Done/All filter tabs, the
 * progress bar, the workspace tree, and the capability registry card — is task-list
 * context, not global chrome. It used to render on every view (cockpit, attention, the
 * observability panels, ...) because none of that JSX was gated on `view` at all. Scoped
 * to the Tasks view only: the 'review' (design-review) screen is also task-adjacent but
 * has its own dedicated context, so it deliberately gets the nav-only rail too — see the
 * PR body for that call. Exported + pure so the scoping rule is unit-tested.
 */
export function isTaskScopedView(view: AppView): boolean {
  return view === 'tasks';
}

/**
 * Rail footer context line (taste-review nit 1, GRAPH-FOLD.md §6e follow-up): the task-scoped
 * block above only renders on Tasks, so every other view left the expanded rail's middle area an
 * empty void below four short nav rows — reads as unfinished, not deliberate. One calm line,
 * anchored to the existing footer strip (never a new panel), gives every view a reason for the
 * space. Empty string means "render nothing" — Tasks itself stays silent here since the
 * task-scoped block already fills the rail. Pure + exported so the per-view copy is unit-tested.
 */
export function railFooterContext(
  view: AppView,
  ctx: { needsYouCount: number; packCount: number; catalogCount: number },
): string {
  switch (view) {
    case 'fleet':
      return ctx.needsYouCount > 0
        ? `${ctx.needsYouCount} agent${ctx.needsYouCount === 1 ? ' needs' : 's need'} you`
        : 'All clear — nothing needs you';
    case 'omp-graph':
      return 'Fleet activity, cost, and lineage over time';
    case 'fog':
      return 'Comprehension debt — what nobody has looked at yet';
    case 'friction':
      return 'The dogfood gripe ledger — friction you and the daemon logged';
    case 'capabilities':
      return `${ctx.packCount} trusted pack${ctx.packCount === 1 ? '' : 's'} · ${ctx.catalogCount} in the catalog`;
    case 'org':
      return 'Organization and peer settings';
    case 'intervene':
      return 'Stepping into one agent';
    case 'review':
      return 'Design review';
    case 'tasks':
    default:
      return '';
  }
}

/**
 * The nav rail: Fleet · Tasks · Graph · Capabilities (GRAPH-FOLD.md §6e's four-item shell), plus
 * Fog (comprehension batch-3 review — mounts HeatTree's fog overlay, which had no render site
 * since GRAPH-FOLD retired the old Heat page; see FogView.tsx's own doc for why this is a new view,
 * not a resurrection of the retired one). The old Attention/Plan/Observe/Network sections are gone
 * — the three attention views dissolved into Fleet (§6f), the five Observe pages folded into the
 * Graph/header/inspector, Federation parked in Org settings, and the Knowledge base became the ⌘K
 * palette's fabric search. Five items need no section headers; Org/settings moved to the gear at
 * the bottom of the rail.
 */
export const NAV_ITEMS: { view: AppView; label: string; icon: LucideIcon; title: string }[] = [
  { view: 'fleet', label: 'Fleet', icon: Layers, title: 'Fleet — roster, transcript, land rail' },
  { view: 'tasks', label: 'Tasks', icon: Inbox, title: 'Tasks' },
  { view: 'omp-graph', label: 'Graph', icon: Waypoints, title: 'Graph — the living temporal dashboard' },
  { view: 'fog', label: 'Fog', icon: CloudFog, title: 'Fog — comprehension debt: what nobody has looked at yet' },
  { view: 'friction', label: 'Friction', icon: MessageSquareWarning, title: 'Friction — the dogfood gripe ledger: what annoyed you (and the daemon)' },
  { view: 'capabilities', label: 'Capabilities', icon: Boxes, title: 'Capabilities' },
];

interface WorkbenchPaneProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * One task row in the rail. The left glyph + row tint + inline pill encode the
 * agent posture (blocked/errored = red, stopped/land = amber, working = green),
 * so what needs you reads at a glance — the parent sorts these so they float up.
 */

export const TaskRailRow: React.FC<{
  task: Task;
  status?: TaskStatus;
  isActive: boolean;
  isDone: boolean;
  dueSoon: boolean;
  priorityColor: string;
  onSelect: () => void;
  onDelete: () => void;
}> = ({ task, status, isActive, isDone, dueSoon, priorityColor, onSelect, onDelete }) => {
  // Float-worthy = anything that wants a decision: blocked/errored (critical) or
  // land-ready / stopped (warn). Working is alive but needs nothing.
  const attention = !isDone && (status?.posture === 'needs-you' || status?.posture === 'idle');
  const critical = attention && status?.verdict === 'critical';
  const isWorking = !isDone && status?.posture === 'working';
  const attnLabel = status?.posture === 'idle' ? 'stopped' : critical ? 'needs you' : 'land ready';
  // Readable secondary handle: Plane ticket or plan slug — never a raw UUID.
  const ref = taskRef(task);
  return (
    <div
      className={`group flex min-h-12 items-stretch border-b border-gray-100 transition-colors dark:border-gray-800/50 ${isActive ? 'border-l-2 border-l-amber-500 bg-amber-50 dark:bg-amber-900/20' : critical ? 'border-l-2 border-l-red-400 bg-red-50/60 hover:bg-red-50 dark:border-l-red-500 dark:bg-red-900/15' : attention ? 'border-l-2 border-l-amber-400 bg-amber-50/50 hover:bg-amber-50 dark:border-l-amber-500 dark:bg-amber-900/10' : 'border-l-2 border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-900/70'}`}
    >
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center py-1 pl-2 text-left focus-visible:ring-2 focus-visible:ring-amber-500">
        <span className="ml-0.5 flex w-5 flex-shrink-0 justify-center" title={status && status.total > 0 ? status.headline : `Status: ${task.properties.status}`}>
          {isDone ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
          ) : attention ? (
            <AlertCircle className={`h-3.5 w-3.5 ${critical ? 'text-red-500' : 'text-amber-500'}`} aria-hidden="true" />
          ) : isWorking ? (
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
          ) : (
            <Circle className={`h-3.5 w-3.5 ${isActive ? 'text-amber-400' : 'text-gray-300 dark:text-gray-600'}`} aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 px-2">
          <span className={`block truncate ${isDone ? 'text-gray-400 line-through dark:text-gray-600' : isActive ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`} title={task.title}>
            {task.title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {ref && (
              <span className={`max-w-[8rem] truncate font-medium ${isDone ? 'text-gray-400 dark:text-gray-600' : isActive ? 'text-amber-700 dark:text-amber-400' : 'text-amber-600 dark:text-amber-500'}`} title={task.planDir ?? task.id}>
                {ref}
              </span>
            )}
            {dueSoon && (
              <span title="Due within 24 hours" className="flex">
                <AlertCircle className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
              </span>
            )}
            {task.priority && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${priorityColor}`} title={`Priority: ${task.priority}`} />}
            <span className={`max-w-[5.5rem] truncate rounded px-1.5 py-0.5 text-[10px] font-medium ${getCategoryBadge(task.category)}`}>
              {task.category}
            </span>
            {attention && (
              <span className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold ${critical ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'}`}>
                {attnLabel}
              </span>
            )}
            {isWorking && status && status.working.length > 0 && (
              <span className="flex-shrink-0 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">{status.working.length} working</span>
            )}
          </span>
        </span>
        <span className={`ml-1 w-8 flex-shrink-0 text-right ${isActive ? 'font-medium text-gray-500 dark:text-gray-400' : 'text-gray-400 dark:text-gray-500'}`}>{task.duration}</span>
      </button>
      <button
        className="mr-1 flex min-h-10 w-8 flex-shrink-0 items-center justify-center self-center rounded text-gray-400 opacity-0 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-amber-500 group-hover:opacity-100 dark:hover:bg-red-900/30"
        onClick={onDelete}
        aria-label={`Archive ${task.title}`}
        title="Archive task"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};

export const WorkbenchPane = ({ collapsed, onToggleCollapsed }: WorkbenchPaneProps) => {
  const {
    tasks,
    projects,
    currentProject,
    projectDtos,
    selectProject,
    addProject,
    removeProject,
    connected,
    selectedTaskId,
    selectTask,
    deleteTask,
    restoreFeature,
    hardDeleteFeature,
    loadArchivedFeatures,
    addTask,
    showToast,
    view,
    setView,
    taskFilter,
    setTaskFilter,
    capabilities,
    publicCatalog,
    agents,
  } = useTaskContext();
  // The "garbage bin": archived features, restorable or permanently deletable.
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<ArchivedFeature[]>([]);
  const [archivedConfirm, setArchivedConfirm] = useState<string | null>(null);
  const refreshArchived = React.useCallback(() => { void loadArchivedFeatures().then(setArchived); }, [loadArchivedFeatures]);
  useEffect(() => {
    if (view !== 'tasks') return;
    let alive = true;
    void loadArchivedFeatures().then((rows) => { if (alive) setArchived(rows); });
    return () => { alive = false; };
    // loadArchivedFeatures is a fresh closure each render; re-run only when the view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // Lightweight "needs you" count for the Fleet nav badge — blocked, errored, or ready to land.
  // (The Fleet roster does the full synthesis; this is just enough for a glanceable badge. §6g:
  // the count must persist in the nav on EVERY view, so a blocked agent never waits off-screen.)
  const needsYouCount = agents.filter(
    (a) => a.status === 'input' || a.status === 'error' || a.pending.length > 0 || a.landReady,
  ).length;
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [drilled, setDrilled] = useState(false); // Tasks drill-down: hide the nav and focus the task list
  const showTaskDrill = view === 'tasks' && drilled;
  // Search / filter tabs / progress / workspace tree / capability registry: task-list
  // context, not global chrome — only render on the Tasks view (list or detail).
  const showTaskScopedBlock = isTaskScopedView(view);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectRepo, setNewProjectRepo] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Task['category']>('all');
  const [sortBy, setSortBy] = useState<'attention' | 'creation'>('attention');
  const [isListening, setIsListening] = useState(false);
  const voiceSessionRef = useRef<VoiceInputSession | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => () => { voiceSessionRef.current?.abort(); }, []); // stop listening on unmount

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.status === 'done').length;
  const progressPercentage = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);
  const allAvailableTags = Array.from(new Set(tasks.flatMap((task) => task.tags || [])));
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);

  // Per-task agent posture — drives the attention sort and the row markers, so a
  // task whose agent is blocked floats up and reads as urgent at a glance.
  const taskStatuses = React.useMemo(() => {
    const map = new Map<string, TaskStatus>();
    for (const task of tasks) {
      const featureId = task.sourceId ?? task.id;
      const taskAgents = agents.filter((a) => a.repo === task.properties.project.id && a.featureId === featureId);
      map.set(task.id, summarizeTask(taskAgents, { hasPlan: task.contextBundle.spec.startsWith('plans/') }));
    }
    return map;
  }, [tasks, agents]);
  const statusFor = (task: Task): TaskStatus => taskStatuses.get(task.id) ?? summarizeTask([]);

  const taskCount = (filter: TaskFilter) => tasks.filter((task) => {
    if (filter === 'all') return true;
    if (filter === 'done') return task.status === 'done';
    if (filter === 'active') return task.status === 'active';
    return task.status !== 'done';
  }).length;

  const filteredTasks = tasks.filter((task) => {
    const showInCurrentView = taskFilter === 'all' || (taskFilter === 'done' ? task.status === 'done' : taskFilter === 'active' ? task.status === 'active' : task.status !== 'done');
    if (!showInCurrentView) return false;
    const matchesSearch = matchesTaskSearch(task, searchQuery);
    const matchesCategory = categoryFilter === 'all' || task.category === categoryFilter;
    const matchesTags = selectedTags.length === 0 || selectedTags.every((tag) => task.tags?.includes(tag));
    return matchesSearch && matchesCategory && matchesTags;
  }).sort((a, b) => compareTaskRail(a, b, sortBy, (t) => taskListRank(statusFor(t), t.status === 'done')));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (view !== 'tasks') return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const currentIndex = filteredTasks.findIndex((task) => task.id === selectedTaskId);
      if (currentIndex === -1) {
        if (filteredTasks.length > 0) selectTask(filteredTasks[0].id);
        return;
      }
      if (event.key === 'ArrowUp' && currentIndex > 0) selectTask(filteredTasks[currentIndex - 1].id);
      if (event.key === 'ArrowDown' && currentIndex < filteredTasks.length - 1) selectTask(filteredTasks[currentIndex + 1].id);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredTasks, selectedTaskId, selectTask, view]);

  const exportTasks = () => {
    const dataStr = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(tasks, null, 2))}`;
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', dataStr);
    downloadAnchorNode.setAttribute('download', 'tasks_backup.json');
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    showToast('Tasks exported successfully', 'info');
  };

  const handleCreateTask = () => {
    addTask({
      title: 'New Task',
      category: 'frontend',
      duration: '1d',
      status: 'todo',
    });
  };

  const handleVoiceToTask = () => {
    if (isListening) {
      voiceSessionRef.current?.abort();
      return;
    }
    // One utterance → one task, same as this button's original behavior (`continuous` defaults to
    // false) — unlike the composer's chained multi-sentence dictation, this isn't a review-then-
    // send draft, so it stays a deliberately short, single-shot capture.
    const session = startVoiceInput({
      onListeningChange: setIsListening,
      onTranscript: (transcript) => addTask({ title: transcript, category: 'frontend', duration: '1d', status: 'todo' }),
      onError: (info) => showToast(info.message, 'error'),
    });
    if (!session) {
      showToast('Speech recognition is not supported in this browser.', 'error');
      return;
    }
    voiceSessionRef.current = session;
  };

  const toggleTagFilter = (tag: string) => {
    setSelectedTags((previous) => (
      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag]
    ));
  };

  const isDueSoon = (dueDateStr?: string | null) => {
    if (!dueDateStr) return false;
    const dueDate = new Date(dueDateStr).getTime();
    const diff = dueDate - Date.now();
    return diff > 0 && diff <= 24 * 60 * 60 * 1000;
  };

  const getPriorityColor = (priority: Task['priority'] | null | undefined) => {
    switch (priority) {
      case 'High': return 'bg-red-400';
      case 'Medium': return 'bg-amber-400';
      case 'Low': return 'bg-blue-400';
      default: return 'bg-gray-300';
    }
  };

  const footerContext = railFooterContext(view, {
    needsYouCount,
    packCount: capabilities.packs.length,
    catalogCount: publicCatalog.length,
  });

  const collapsedLabel = view === 'fleet'
    ? `Fleet${needsYouCount ? ` · ${needsYouCount} need you` : ''}`
    : view === 'tasks'
    ? `${filteredTasks.length} tasks${selectedTask ? ` · ${taskRef(selectedTask) ?? selectedTask.title}` : ''}`
    : view === 'capabilities' ? `${capabilities.packs.length} packs`
    : view === 'omp-graph' ? 'Graph'
    : view === 'fog' ? 'Fog'
    : view === 'friction' ? 'Friction'
    : view === 'org' ? 'Settings'
    : '';

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 flex-shrink-0 flex-col items-center border-r border-gray-200 bg-gray-50 py-1.5 dark:border-gray-800 dark:bg-[#18191b]">
        <button onClick={onToggleCollapsed} className="mb-1 flex min-h-10 w-10 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" aria-label="Expand workbench pane" title="Expand workbench pane">
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isFleet = item.view === 'fleet';
          return (
            <button
              key={item.view}
              onClick={() => setView(item.view)}
              className={`relative mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${view === item.view ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
              aria-label={isFleet && needsYouCount ? `${item.label} (${needsYouCount} need you)` : item.label}
              title={item.title}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {/* §6g: the needs-you count survives the collapse — a blocked agent must never
                  quietly wait behind a folded rail. */}
              {isFleet && needsYouCount > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />}
            </button>
          );
        })}
        <div className="mt-3 flex h-full items-center">
          <div className="-rotate-90 whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-gray-400">
            {collapsedLabel}
          </div>
        </div>
        {/* The gear — org/settings live here now (GRAPH-FOLD.md §6e), not in the nav. */}
        <button
          onClick={() => setView('org')}
          className={`mb-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${view === 'org' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`}
          aria-label="Organization settings"
          title="Organization settings"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className={`mb-2 h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-gray-400'}`} title={connected ? 'Daemon live' : 'Daemon offline'} />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[22rem] flex-shrink-0 flex-col border-r border-gray-200 bg-white transition-colors duration-200 dark:border-gray-800 dark:bg-gray-950">
      <div className="border-b border-gray-200 bg-gray-50/70 px-3 py-2 dark:border-gray-800 dark:bg-gray-950">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <GlanceLogo size={20} className="flex-shrink-0 text-gray-900 dark:text-gray-100" />
            <span className="font-semibold text-gray-900 dark:text-gray-100">glance</span>
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-gray-400" aria-hidden="true" />
            <span className="truncate font-medium text-gray-600 dark:text-gray-300">{currentProject?.name ?? 'No project'}</span>
            <span className={`flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${connected ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-gray-400'}`} aria-hidden="true" />
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <button onClick={onToggleCollapsed} className="flex min-h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-gray-800 dark:hover:text-gray-300" aria-label="Collapse workbench pane" title="Collapse workbench pane">
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {showTaskDrill ? (
          <button
            onClick={() => setDrilled(false)}
            className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-100 dark:hover:bg-gray-800/70"
            title="Back to navigation"
          >
            <ChevronLeft className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
            <Inbox className="h-4 w-4 flex-shrink-0 text-blue-500" aria-hidden="true" />
            Tasks
            <span className="ml-auto font-mono text-[11px] text-gray-400">{filteredTasks.length}</span>
          </button>
        ) : (
          <nav className="mt-2 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = view === item.view;
            const badge = item.view === 'fleet' ? needsYouCount : item.view === 'capabilities' ? capabilities.packs.length : 0;
            return (
              <button
                key={item.view}
                onClick={() => { setView(item.view); setDrilled(item.view === 'tasks'); }}
                aria-current={active ? 'page' : undefined}
                title={item.title}
                className={`group flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${active ? 'bg-amber-50 font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-gray-200'}`}
              >
                <Icon className={`h-4 w-4 flex-shrink-0 ${active ? '' : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'}`} aria-hidden="true" />
                <span className="flex-1 truncate text-left">{item.label}</span>
                {badge > 0 && (
                  <span className={`min-w-[18px] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none ${active ? 'bg-amber-500 text-white' : item.view === 'fleet' ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
          </nav>
        )}

        {showTaskScopedBlock && (
        <div className="mt-2">
          <label className="sr-only" htmlFor="workbench-search">Search tasks</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            {/* No ⌘K chip here anymore: the hotkey opens the command palette now, not this box —
                the palette's "Search tasks…" row is what routes here. A chip must never advertise
                a key that isn't actually bound to this control. */}
            <input
              id="workbench-search"
              type="search"
              className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-xs text-gray-900 transition-colors duration-150 placeholder:text-gray-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200"
              placeholder="Search tasks by title or ID"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-custom">
        {showTaskScopedBlock && (
        <>
        <div className="border-b border-gray-200 p-3 dark:border-gray-800">
          <div className="grid grid-cols-4 gap-1">
            {taskFilters.map((filter) => (
              <button key={filter.key} onClick={() => setTaskFilter(filter.key)} className={`min-h-9 rounded-md px-2 text-left text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${taskFilter === filter.key ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'}`}>
                <span className="block font-medium">{filter.label}</span>
                <span className="font-mono text-[10px] text-gray-400">{taskCount(filter.key)}</span>
              </button>
            ))}
          </div>
          <div className="mt-3">
            <div className="mb-1.5 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              <span>Progress</span>
              <span className="font-mono">{progressPercentage}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800">
              <div className="h-1.5 rounded-full bg-amber-500 transition-[width] duration-300 ease-out" style={{ width: `${progressPercentage}%` }} />
            </div>
            <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              {completedTasks} of {totalTasks} features completed · {connected ? 'live' : 'offline'}
            </div>
          </div>
        </div>

        {!showTaskDrill && (
        <section className="border-b border-gray-200 dark:border-gray-800">
          <button onClick={() => setWorkspaceOpen((open) => !open)} className="flex min-h-9 w-full items-center gap-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400 transition-colors hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:text-gray-300">
            {workspaceOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            Workspace
          </button>
          {workspaceOpen && (
            <div className="pb-3">
              {/* A project ROW switches the workspace; the chevron only expands its counts. These used to
                * be the same button, and it toggled a disclosure — so nothing in the UI could switch
                * projects at all. Counts come from `projectDtos` (never scoped), because `tasks` is now
                * scoped to the current project and would report 0 for every other one. */}
              {Object.entries(projects).flatMap(([, teamProjects]) => teamProjects).map((project) => {
                const isActive = project.id === currentProject?.id;
                const open = openProjects[project.id] ?? false;
                const dto = projectDtos.find((p) => p.id === project.id);
                return (
                  <div key={project.id}>
                    <div className={`flex min-h-9 w-full items-center ${isActive ? 'bg-gray-50 dark:bg-gray-900/60' : ''}`}>
                      <button
                        onClick={() => setOpenProjects((state) => ({ ...state, [project.id]: !open }))}
                        aria-label={open ? `Collapse ${project.name} details` : `Expand ${project.name} details`}
                        aria-expanded={open}
                        className="flex h-9 w-6 flex-shrink-0 items-center justify-center text-gray-400 transition-colors hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:text-gray-300"
                      >
                        {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                      </button>
                      <button
                        onClick={() => selectProject(project.id)}
                        aria-current={isActive ? 'true' : undefined}
                        title={project.id}
                        className={`flex min-h-9 min-w-0 flex-1 items-center justify-between pr-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${isActive ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900/70'}`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${isActive ? project.colorClass : 'bg-transparent ring-1 ring-gray-300 dark:ring-gray-600'}`} aria-hidden="true" />
                          <span className="truncate">{project.name}</span>
                        </span>
                        <span className="ml-2 flex-shrink-0 text-[10px] text-gray-400">{project.shortCode}</span>
                      </button>
                    </div>
                    {open && (
                      <div className="ml-8 space-y-1 pb-1 text-xs text-gray-500 dark:text-gray-400">
                        <div className="flex items-center gap-2"><ListChecks className="h-3 w-3" aria-hidden="true" /> Features <span className="font-mono text-gray-400">{dto?.featureCount ?? 0}</span></div>
                        <div className="flex items-center gap-2"><ChevronRight className="h-3 w-3" aria-hidden="true" /> Agents <span className="font-mono text-gray-400">{dto?.agentCount ?? 0}</span></div>
                        <div className="truncate font-mono text-[10px] text-gray-400" title={project.id}>{project.id}</div>
                        {dto?.registered && (
                          <button
                            onClick={() => void removeProject(project.id)}
                            className="text-[11px] text-gray-400 underline-offset-2 transition-colors hover:text-red-500 hover:underline focus-visible:ring-2 focus-visible:ring-amber-500"
                          >
                            Remove from workspace
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* The only add-a-project affordance in the app was FirstRunSetup, gated on having ZERO
                * projects — so it showed exactly once and was unreachable ever after. */}
              {addingProject ? (
                <form
                  className="mt-1 px-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addProject(newProjectRepo).then(() => { setNewProjectRepo(''); setAddingProject(false); });
                  }}
                >
                  <label htmlFor="wb-add-project" className="sr-only">Absolute path to a git repository</label>
                  <input
                    id="wb-add-project"
                    autoFocus
                    value={newProjectRepo}
                    onChange={(event) => setNewProjectRepo(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') { setAddingProject(false); setNewProjectRepo(''); } }}
                    placeholder="/absolute/path/to/repo"
                    className="min-h-9 w-full rounded border border-gray-300 bg-white px-2 text-xs text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                  <p className="mt-1 text-[10px] text-gray-400">Must be an absolute path to a git repository.</p>
                </form>
              ) : (
                <button
                  onClick={() => setAddingProject(true)}
                  className="mt-1 flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-900/70 dark:hover:text-gray-200"
                >
                  <span aria-hidden="true" className="text-sm leading-none">+</span> Add project…
                </button>
              )}
            </div>
          )}
        </section>
        )}

        {showTaskDrill ? (
          <>
            <section className="border-b border-gray-200 dark:border-gray-800">
              <button onClick={() => setFiltersOpen((open) => !open)} className="flex min-h-9 w-full items-center justify-between px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-900/70">
                <span className="flex items-center gap-1.5">
                  {filtersOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
                  <Filter className="h-3.5 w-3.5" aria-hidden="true" />
                  Filters
                </span>
                <span className="font-mono text-[10px] text-gray-400">{filteredTasks.length}</span>
              </button>
              {filtersOpen && (
                <div className="space-y-2 px-3 pb-3">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Category</span>
                      <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | Task['category'])} className="min-h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                        {categories.map((category) => (
                          <option key={category} value={category}>{category === 'all' ? 'All categories' : category}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Sort</span>
                      <select value={sortBy} onChange={(event) => setSortBy(event.target.value as 'attention' | 'creation')} className="min-h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                        <option value="attention">Attention</option>
                        <option value="creation">Creation</option>
                      </select>
                    </label>
                  </div>
                  {allAvailableTags.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
                      <Tag className="h-3 w-3 flex-shrink-0 text-gray-400" aria-hidden="true" />
                      {allAvailableTags.map((tag) => (
                        <button key={tag} onClick={() => toggleTagFilter(tag)} className={`min-h-8 flex-shrink-0 rounded border px-2 text-[10px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${selectedTags.includes(tag) ? 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-300' : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'}`}>
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            <button
              type="button"
              onClick={() => setShowArchived((value) => !value)}
              className="flex min-h-9 w-full items-center justify-between border-b border-gray-200 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900/70"
              aria-expanded={showArchived}
            >
              <span className="flex items-center gap-1.5">
                <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                {showArchived ? 'Hide archived' : 'Archived'}
              </span>
              {archived.length > 0 && <span className="rounded-full bg-gray-200 px-1.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{archived.length}</span>}
            </button>

            {showArchived ? (
              <section aria-label="Archived features">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-200 bg-gray-50/95 px-3 py-1 text-xs font-medium text-gray-600 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 dark:text-gray-400">
                  <Archive className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
                  ARCHIVED
                  <span className="font-mono text-[10px] text-gray-400">{archived.length}</span>
                </div>
                <div className="flex flex-col text-xs">
                  {archived.length === 0 ? (
                    <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">Nothing archived. Archived plans land here — restore them or delete permanently.</div>
                  ) : (
                    archived.map((feature) => (
                      <div key={feature.id} className="group flex min-h-12 items-center gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-800/50">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-gray-700 dark:text-gray-300" title={feature.title}>{feature.title}</div>
                          <div className="truncate font-mono text-[10px] text-gray-400" title={feature.planDir ?? feature.id}>{feature.planDir ?? feature.id}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => { void restoreFeature(feature.id, feature.repo).then(refreshArchived); }}
                          className="flex min-h-8 items-center gap-1 rounded px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                          title="Restore — un-archive and move the plan back"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden="true" /> Restore
                        </button>
                        {archivedConfirm === feature.id ? (
                          <button
                            type="button"
                            onClick={() => { void hardDeleteFeature(feature.id, { repo: feature.repo }).then(refreshArchived); setArchivedConfirm(null); }}
                            className="flex min-h-8 items-center gap-1 rounded bg-red-600 px-2 text-[11px] font-semibold text-white transition-colors hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500"
                            title="Confirm: permanently delete the feature and its plan files"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" /> Confirm
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setArchivedConfirm(feature.id)}
                            className="flex min-h-8 items-center gap-1 rounded px-2 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-900/30"
                            title="Delete permanently (plan files removed)"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </section>
            ) : (
            <section>
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-gray-50/95 px-3 py-1 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
                <div className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                  <Layers className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />
                  PLANNABLE
                  <span className="font-mono text-[10px] text-gray-400">{filteredTasks.length}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={handleVoiceToTask} className={`flex min-h-8 min-w-8 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${isListening ? 'bg-red-100 text-red-500 dark:bg-red-900/30' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300'}`} aria-label="Create task from voice" title="Create task from voice">
                    <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  {/* Kbd chip mirrors the REAL binding GlobalShortcuts registers (⌘/Ctrl+N) — the
                      reference shows a bare `N`, but a chip must never advertise a key that isn't
                      actually bound. */}
                  <button onClick={handleCreateTask} className="flex min-h-8 items-center justify-center gap-1 rounded px-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-gray-800 dark:hover:text-gray-300" aria-label="Create task" title="Create task (⌘N)">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <Kbd keys="⌘N" />
                  </button>
                </div>
              </div>

              <div className="flex flex-col text-xs">
                {filteredTasks.length === 0 ? (
                  <div className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">No tasks match your filters.</div>
                ) : (
                  filteredTasks.map((task) => (
                    <TaskRailRow
                      key={task.id}
                      task={task}
                      status={taskStatuses.get(task.id)}
                      isActive={task.id === selectedTaskId}
                      isDone={task.status === 'done'}
                      dueSoon={isDueSoon(task.dueDate) && task.status !== 'done'}
                      priorityColor={getPriorityColor(task.priority)}
                      onSelect={() => selectTask(task.id)}
                      onDelete={() => deleteTask(task.id)}
                    />
                  ))
                )}
              </div>
            </section>
            )}
          </>
        ) : (
          <section className="p-3">
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900/60">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-900 dark:text-gray-100">
                <Boxes className="h-4 w-4 text-blue-500" aria-hidden="true" />
                Capability registry
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
                <div className="rounded border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-950">
                  <b className="block font-mono text-gray-900 dark:text-gray-100">{capabilities.packs.length}</b>
                  trusted packs
                </div>
                <div className="rounded border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-950">
                  <b className="block font-mono text-gray-900 dark:text-gray-100">{publicCatalog.length}</b>
                  catalog entries
                </div>
              </div>
            </div>
          </section>
        )}
        </>
        )}
      </div>

      <div className="border-t border-gray-200 dark:border-gray-800">
        {/* Taste-review nit 1: the calm footer-anchored context line — non-Tasks views only, the
            task-scoped block above already speaks for Tasks. */}
        {footerContext && (
          <div className="border-b border-gray-100 px-3 py-2 dark:border-gray-800/50">
            <MonoLabel>{footerContext}</MonoLabel>
          </div>
        )}
        <button onClick={exportTasks} className="flex min-h-10 w-full items-center gap-2 border-b border-gray-200 px-3 text-xs text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200">
          <Download className="h-4 w-4" aria-hidden="true" />
          Export Snapshot
        </button>
        <div className="flex min-h-11 items-center justify-between px-3 text-gray-600 dark:text-gray-400">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs text-white">G</div>
            <span className="truncate text-xs">{connected ? 'Daemon live' : 'Daemon offline'}</span>
          </div>
          {/* The gear (GRAPH-FOLD.md §6e): org/settings left the nav — this is its home now.
              AccountMenu (identity, push, sign-out; db mode only) sits beside it. */}
          <div className="flex flex-shrink-0 items-center gap-1">
            <AccountMenu />
            <button
              onClick={() => setView('org')}
              className={`flex min-h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 ${view === 'org' ? 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-200' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300'}`}
              aria-label="Organization settings"
              title="Organization settings"
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
