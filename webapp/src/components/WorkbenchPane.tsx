import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Archive,
  Bell,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Filter,
  GripVertical,
  Inbox,
  Library,
  RotateCcw,
  Layers,
  ListChecks,
  Menu,
  Mic,
  Network,
  Plus,
  Radar,
  Search,
  Settings,
  Tag,
  Thermometer,
  Trash2,
  Waypoints,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { getCategoryBadge } from '../utils';
import { useTaskContext, type AppView, type TaskFilter, type ArchivedFeature } from '../context/TaskContext';
import { summarizeTask, taskListRank, type TaskStatus } from '../lib/taskStatus';
import { activeWork } from '../lib/insights';
import { taskRef } from '../lib/task-model';
import { AccountMenu } from './AccountMenu';
import { GlanceLogo } from './GlanceLogo';
import type { Task } from '../types';

const taskFilters: Array<{ key: TaskFilter; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
];

const categories: Array<'all' | Task['category']> = ['all', 'frontend', 'backend', 'devops', 'mcp', 'database'];

/** Grouped VERTICAL navigation — a list that grows down instead of tab rows that
 *  overflow sideways. Sections give structure (the reference-timeline sidebar idiom). */
const NAV_SECTIONS: { title: string; items: { view: AppView; label: string; icon: LucideIcon }[] }[] = [
  {
    title: 'Attention',
    items: [
      { view: 'attention', label: 'Needs you', icon: Bell },
      { view: 'active', label: 'Active work', icon: Radar },
    ],
  },
  {
    title: 'Plan',
    items: [
      { view: 'tasks', label: 'Tasks', icon: Inbox },
      { view: 'capabilities', label: 'Capabilities', icon: Boxes },
    ],
  },
  {
    title: 'Observe',
    items: [
      { view: 'automation', label: 'Automation', icon: Zap },
      { view: 'fleet-health', label: 'Fleet health', icon: Activity },
      { view: 'heat', label: 'Heat map', icon: Thermometer },
      { view: 'activity-heatmap', label: 'Activity rhythm', icon: CalendarClock },
      { view: 'omp-graph', label: 'Graph', icon: Waypoints },
    ],
  },
  {
    title: 'Network',
    items: [
      { view: 'federation', label: 'Federation', icon: Network },
      { view: 'knowledge', label: 'Knowledge base', icon: Library },
    ],
  },
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
  isDraggable: boolean;
  dragging: boolean;
  priorityColor: string;
  onSelect: () => void;
  onDelete: () => void;
  onDragStart?: (event: React.DragEvent) => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDrop?: (event: React.DragEvent) => void;
}> = ({ task, status, isActive, isDone, dueSoon, isDraggable, dragging, priorityColor, onSelect, onDelete, onDragStart, onDragOver, onDragEnd, onDrop }) => {
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
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={`group flex min-h-12 items-stretch border-b border-gray-100 transition-colors dark:border-gray-800/50 ${isActive ? 'border-l-2 border-l-blue-500 bg-blue-50 dark:bg-blue-900/20' : critical ? 'border-l-2 border-l-red-400 bg-red-50/60 hover:bg-red-50 dark:border-l-red-500 dark:bg-red-900/15' : attention ? 'border-l-2 border-l-amber-400 bg-amber-50/50 hover:bg-amber-50 dark:border-l-amber-500 dark:bg-amber-900/10' : 'border-l-2 border-l-transparent hover:bg-gray-50 dark:hover:bg-gray-900/70'} ${dragging ? 'opacity-50' : 'opacity-100'}`}
    >
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center py-1 pl-2 text-left focus-visible:ring-2 focus-visible:ring-blue-500">
        <span className={`flex w-3 justify-center ${isDraggable ? 'cursor-grab text-gray-300 opacity-0 group-hover:opacity-100 group-active:cursor-grabbing' : 'opacity-0'}`}>
          <GripVertical className="h-3 w-3" aria-hidden="true" />
        </span>
        <span className="ml-0.5 flex w-5 flex-shrink-0 justify-center" title={status && status.total > 0 ? status.headline : `Status: ${task.properties.status}`}>
          {isDone ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
          ) : attention ? (
            <AlertCircle className={`h-3.5 w-3.5 ${critical ? 'text-red-500' : 'text-amber-500'}`} aria-hidden="true" />
          ) : isWorking ? (
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
          ) : (
            <Circle className={`h-3.5 w-3.5 ${isActive ? 'text-blue-400' : 'text-gray-300 dark:text-gray-600'}`} aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 px-2">
          <span className={`block truncate ${isDone ? 'text-gray-400 line-through dark:text-gray-600' : isActive ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}`} title={task.title}>
            {task.title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {ref && (
              <span className={`max-w-[8rem] truncate font-medium ${isDone ? 'text-gray-400 dark:text-gray-600' : isActive ? 'text-blue-700 dark:text-blue-400' : 'text-blue-600 dark:text-blue-500'}`} title={task.planDir ?? task.id}>
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
        className="mr-1 flex min-h-10 w-8 flex-shrink-0 items-center justify-center self-center rounded text-gray-400 opacity-0 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500 group-hover:opacity-100 dark:hover:bg-red-900/30"
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
    connected,
    selectedTaskId,
    selectTask,
    deleteTask,
    restoreFeature,
    hardDeleteFeature,
    loadArchivedFeatures,
    addTask,
    reorderTasks,
    showToast,
    view,
    setView,
    taskFilter,
    setTaskFilter,
    capabilities,
    publicCatalog,
    agents,
    features,
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
  // Lightweight "needs you" count for the nav badge — blocked, errored, or ready to land.
  // (The Attention panel does the full synthesis; this is just enough for a glanceable badge.)
  const needsYouCount = agents.filter(
    (a) => a.status === 'input' || a.status === 'error' || a.pending.length > 0 || a.landReady,
  ).length;
  // Live count of things currently being worked on — drives the Active nav badge.
  const activeWorkCount = React.useMemo(() => activeWork(agents, features).length, [agents, features]);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [drilled, setDrilled] = useState(false); // Tasks drill-down: hide the nav and focus the task list
  const showTaskDrill = view === 'tasks' && drilled;
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | Task['category']>('all');
  const [sortBy, setSortBy] = useState<'attention' | 'creation' | 'dueDate'>('attention');
  const [isListening, setIsListening] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

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
    const query = searchQuery.toLowerCase();
    const matchesSearch = task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query);
    const matchesCategory = categoryFilter === 'all' || task.category === categoryFilter;
    const matchesTags = selectedTags.length === 0 || selectedTags.every((tag) => task.tags?.includes(tag));
    return matchesSearch && matchesCategory && matchesTags;
  }).sort((a, b) => {
    if (sortBy === 'attention') {
      // stable: equal ranks keep their existing order, so this only re-floats what needs you
      return taskListRank(statusFor(a), a.status === 'done') - taskListRank(statusFor(b), b.status === 'done');
    }
    if (sortBy !== 'dueDate') return 0;
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });

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
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast('Speech recognition is not supported in this browser.', 'error');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      addTask({ title: transcript, category: 'frontend', duration: '1d', status: 'todo' });
    };
    recognition.start();
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

  const collapsedLabel = view === 'attention'
    ? `Needs you${needsYouCount ? ` · ${needsYouCount}` : ''}`
    : view === 'active'
    ? `Active work${activeWorkCount ? ` · ${activeWorkCount}` : ''}`
    : view === 'tasks'
    ? `${filteredTasks.length} tasks${selectedTask ? ` · ${taskRef(selectedTask) ?? selectedTask.title}` : ''}`
    : view === 'capabilities' ? `${capabilities.packs.length} packs`
    : view === 'automation' ? 'Automation'
    : view === 'fleet-health' ? 'Fleet Health'
    : view === 'heat' ? 'Heat Map'
    : view === 'activity-heatmap' ? 'Activity Rhythm'
    : view === 'omp-graph' ? 'Graph'
    : view === 'federation' ? 'Federation'
    : view === 'knowledge' ? 'Knowledge'
    : '';

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 flex-shrink-0 flex-col items-center border-r border-gray-200 bg-gray-50 py-1.5 dark:border-gray-800 dark:bg-[#18191b]">
        <button onClick={onToggleCollapsed} className="mb-1 flex min-h-10 w-10 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" aria-label="Expand workbench pane" title="Expand workbench pane">
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('attention')} className={`relative flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'attention' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label={`Needs you${needsYouCount ? ` (${needsYouCount})` : ''}`} title="Needs you">
          <Bell className="h-4 w-4" aria-hidden="true" />
          {needsYouCount > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />}
        </button>
        <button onClick={() => setView('active')} className={`mt-1 relative flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'active' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label={`Active work${activeWorkCount ? ` (${activeWorkCount})` : ''}`} title="Active work">
          <Radar className="h-4 w-4" aria-hidden="true" />
          {activeWorkCount > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />}
        </button>
        <button onClick={() => setView('tasks')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'tasks' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Tasks" title="Tasks">
          <Inbox className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('capabilities')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'capabilities' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Capabilities" title="Capabilities">
          <Boxes className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('automation')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'automation' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Automation" title="Automation">
          <Zap className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('fleet-health')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'fleet-health' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Fleet Health" title="Fleet Health">
          <Activity className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('heat')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'heat' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Heat Map" title="Heat Map">
          <Thermometer className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('activity-heatmap')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'activity-heatmap' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Activity Rhythm" title="Activity rhythm — day × hour">
          <CalendarClock className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('omp-graph')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'omp-graph' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Graph" title="Graph — the living temporal dashboard">
          <Waypoints className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('federation')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'federation' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Federation" title="Federation">
          <Network className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('knowledge')} className={`mt-1 flex min-h-10 w-10 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'knowledge' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Knowledge base" title="Knowledge base">
          <Library className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="mt-3 flex h-full items-center">
          <div className="-rotate-90 whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-gray-400">
            {collapsedLabel}
          </div>
        </div>
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
            <AccountMenu />
            <button onClick={onToggleCollapsed} className="flex min-h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-300" aria-label="Collapse workbench pane" title="Collapse workbench pane">
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {showTaskDrill ? (
          <button
            onClick={() => setDrilled(false)}
            className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-semibold text-gray-900 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100 dark:hover:bg-gray-800/70"
            title="Back to navigation"
          >
            <ChevronLeft className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
            <Inbox className="h-4 w-4 flex-shrink-0 text-blue-500" aria-hidden="true" />
            Tasks
            <span className="ml-auto font-mono text-[11px] text-gray-400">{filteredTasks.length}</span>
          </button>
        ) : (
          <nav className="mt-2 space-y-1.5">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">{section.title}</div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = view === item.view;
                  const badge = item.view === 'attention' ? needsYouCount : item.view === 'active' ? activeWorkCount : item.view === 'capabilities' ? capabilities.packs.length : 0;
                  return (
                    <button
                      key={item.view}
                      onClick={() => { setView(item.view); setDrilled(item.view === 'tasks'); }}
                      aria-current={active ? 'page' : undefined}
                      className={`group flex min-h-7 w-full items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${active ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-gray-200'}`}
                    >
                      <Icon className={`h-4 w-4 flex-shrink-0 ${active ? '' : 'text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300'}`} aria-hidden="true" />
                      <span className="flex-1 truncate text-left">{item.label}</span>
                      {badge > 0 && (
                        <span className={`min-w-[18px] rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none ${active ? 'bg-blue-600 text-white' : item.view === 'attention' ? 'bg-red-500 text-white' : item.view === 'active' ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                          {badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          </nav>
        )}

        <div className="mt-2">
          <label className="sr-only" htmlFor="workbench-search">Search tasks or jump</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
            <input
              id="workbench-search"
              type="search"
              className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-20 text-xs text-gray-900 transition-colors duration-150 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200"
              placeholder={view === 'tasks' ? 'Search tasks by title or ID' : 'Search or jump'}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1 text-[10px] text-gray-400" aria-hidden="true">
              <span className="rounded border border-gray-200 bg-gray-100 px-1 dark:border-gray-700 dark:bg-gray-800">Cmd</span>
              <span className="rounded border border-gray-200 bg-gray-100 px-1 dark:border-gray-700 dark:bg-gray-800">K</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-custom">
        <div className="border-b border-gray-200 p-3 dark:border-gray-800">
          <div className="grid grid-cols-4 gap-1">
            {taskFilters.map((filter) => (
              <button key={filter.key} onClick={() => setTaskFilter(filter.key)} className={`min-h-9 rounded-md px-2 text-left text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${taskFilter === filter.key ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'}`}>
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
              <div className="h-1.5 rounded-full bg-blue-500 transition-[width] duration-300 ease-out" style={{ width: `${progressPercentage}%` }} />
            </div>
            <div className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              {completedTasks} of {totalTasks} features completed · {connected ? 'live' : 'offline'}
            </div>
          </div>
        </div>

        {!showTaskDrill && (
        <section className="border-b border-gray-200 dark:border-gray-800">
          <button onClick={() => setWorkspaceOpen((open) => !open)} className="flex min-h-9 w-full items-center gap-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400 transition-colors hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-300">
            {workspaceOpen ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            Workspace
          </button>
          {workspaceOpen && (
            <div className="pb-3">
              {Object.entries(projects).flatMap(([, teamProjects]) => teamProjects).map((project) => {
                const isActive = project.id === currentProject?.id;
                const open = openProjects[project.id] ?? isActive;
                const projectTasks = tasks.filter((task) => task.properties.project.id === project.id);
                const planCount = projectTasks.filter((task) => task.contextBundle.spec.startsWith('plans/')).length;
                const agentCount = projectTasks.filter((task) => /active agent/.test(task.contextBundle.downstream)).length;
                return (
                  <div key={project.id}>
                    <button onClick={() => setOpenProjects((state) => ({ ...state, [project.id]: !open }))} className={`flex min-h-9 w-full items-center justify-between px-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${isActive ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-900/70'}`}>
                      <span className="flex min-w-0 items-center gap-2">
                        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
                        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${project.colorClass}`} aria-hidden="true" />
                        <span className="truncate">{project.name}</span>
                      </span>
                      <span className="ml-2 flex-shrink-0 text-[10px] text-gray-400">{project.shortCode}</span>
                    </button>
                    {open && (
                      <div className="ml-8 space-y-1 pb-1 text-xs text-gray-500 dark:text-gray-400">
                        <div className="flex items-center gap-2"><ListChecks className="h-3 w-3" aria-hidden="true" /> Features <span className="font-mono text-gray-400">{projectTasks.length}</span></div>
                        <div className="flex items-center gap-2"><ChevronRight className="h-3 w-3" aria-hidden="true" /> Plans <span className="font-mono text-gray-400">{planCount}</span></div>
                        <div className="flex items-center gap-2"><ChevronRight className="h-3 w-3" aria-hidden="true" /> Agents <span className="font-mono text-gray-400">{agentCount}</span></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        )}

        {showTaskDrill ? (
          <>
            <section className="border-b border-gray-200 dark:border-gray-800">
              <button onClick={() => setFiltersOpen((open) => !open)} className="flex min-h-9 w-full items-center justify-between px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-900/70">
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
                      <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | Task['category'])} className="min-h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                        {categories.map((category) => (
                          <option key={category} value={category}>{category === 'all' ? 'All categories' : category}</option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Sort</span>
                      <select value={sortBy} onChange={(event) => setSortBy(event.target.value as 'attention' | 'creation' | 'dueDate')} className="min-h-9 w-full rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
                        <option value="attention">Attention</option>
                        <option value="creation">Creation</option>
                        <option value="dueDate">Due date</option>
                      </select>
                    </label>
                  </div>
                  {allAvailableTags.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
                      <Tag className="h-3 w-3 flex-shrink-0 text-gray-400" aria-hidden="true" />
                      {allAvailableTags.map((tag) => (
                        <button key={tag} onClick={() => toggleTagFilter(tag)} className={`min-h-8 flex-shrink-0 rounded border px-2 text-[10px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${selectedTags.includes(tag) ? 'border-indigo-200 bg-indigo-100 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300' : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'}`}>
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
              className="flex min-h-9 w-full items-center justify-between border-b border-gray-200 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900/70"
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
                  <button onClick={handleVoiceToTask} className={`flex min-h-8 min-w-8 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${isListening ? 'bg-red-100 text-red-500 dark:bg-red-900/30' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300'}`} aria-label="Create task from voice" title="Create task from voice">
                    <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button onClick={handleCreateTask} className="flex min-h-8 min-w-8 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-300" aria-label="Create task" title="Create task">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
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
                      isDraggable={sortBy === 'creation' && categoryFilter === 'all' && !searchQuery}
                      dragging={draggedTaskId === task.id}
                      priorityColor={getPriorityColor(task.priority)}
                      onSelect={() => selectTask(task.id)}
                      onDelete={() => deleteTask(task.id)}
                      onDragStart={(event) => { setDraggedTaskId(task.id); event.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragEnd={() => setDraggedTaskId(null)}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggedTaskId && draggedTaskId !== task.id) {
                          const draggedIdx = tasks.findIndex((item) => item.id === draggedTaskId);
                          const targetIdx = tasks.findIndex((item) => item.id === task.id);
                          if (draggedIdx !== -1 && targetIdx !== -1) reorderTasks(draggedIdx, targetIdx);
                        }
                        setDraggedTaskId(null);
                      }}
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
      </div>

      <div className="border-t border-gray-200 dark:border-gray-800">
        <button onClick={exportTasks} className="flex min-h-10 w-full items-center gap-2 border-b border-gray-200 px-3 text-xs text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200">
          <Download className="h-4 w-4" aria-hidden="true" />
          Export Snapshot
        </button>
        <div className="flex min-h-11 items-center justify-between px-3 text-gray-600 dark:text-gray-400">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gray-700 text-xs text-white">G</div>
            <span className="truncate text-xs">{connected ? 'Daemon live' : 'Daemon offline'}</span>
          </div>
          <Settings className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
        </div>
      </div>
    </aside>
  );
};
