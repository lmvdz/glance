import React, { useState } from 'react';
import { Search, Inbox, ChevronDown, ChevronRight, Settings, Menu, Download, Boxes, ListChecks } from 'lucide-react';
import { useTaskContext, type TaskFilter } from '../context/TaskContext';

const filters: Array<{ key: TaskFilter; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'all', label: 'All' },
];

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export const Sidebar = ({ collapsed, onToggleCollapsed }: SidebarProps) => {
  const { tasks, projects, currentProject, connected, showToast, setView, view, taskFilter, setTaskFilter } = useTaskContext();
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'done').length;
  const progressPercentage = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

  const exportTasks = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(tasks, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "tasks_backup.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    showToast("Tasks exported successfully", "info");
  };

  const taskCount = (filter: TaskFilter) => tasks.filter((task) => {
    if (filter === 'all') return true;
    if (filter === 'done') return task.status === 'done';
    if (filter === 'active') return task.status === 'active';
    return task.status !== 'done';
  }).length;

  if (collapsed) {
    return (
      <aside className="flex h-full w-10 flex-shrink-0 flex-col items-center border-r border-gray-200 bg-gray-50 py-1.5 dark:border-gray-800 dark:bg-[#18191b]">
        <button onClick={onToggleCollapsed} className="mb-1 flex min-h-9 w-9 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" aria-label="Expand workspace pane" title="Expand workspace pane">
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('tasks')} className={`flex min-h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'tasks' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Tasks" title="Tasks">
          <Inbox className="h-4 w-4" aria-hidden="true" />
        </button>
        <button onClick={() => setView('capabilities')} className={`mt-1 flex min-h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'capabilities' ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-100' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'}`} aria-label="Capabilities" title="Capabilities">
          <Boxes className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className={`mt-auto mb-2 h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-gray-400'}`} title={connected ? 'Daemon live' : 'Daemon offline'} />
      </aside>
    );
  }

  return (
    <aside className="w-56 flex-shrink-0 flex flex-col h-full bg-gray-50 dark:bg-[#18191b] border-r border-gray-200 dark:border-gray-800 z-10 transition-colors duration-200">
      <div className="h-10 border-b border-gray-200 dark:border-gray-800 flex items-center px-3 justify-between">
        <div className="flex items-center gap-2 font-semibold dark:text-gray-200">
          <div className="w-5 h-5 bg-blue-600 rounded flex items-center justify-center text-white text-[11px]">O</div>
          omp-squad
        </div>
        <button onClick={onToggleCollapsed} className="flex min-h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 focus-visible:ring-2 focus-visible:ring-blue-500" aria-label="Collapse workspace pane" title="Collapse workspace pane">
          <Menu className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-3 h-3" />
          <input
            type="text"
            className="w-full pl-8 pr-8 py-1.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md text-xs focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-gray-400 dark:text-gray-200 transition-colors duration-200"
            placeholder="Search or jump"
          />
          <div className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 text-[10px] flex gap-1">
            <span className="bg-gray-100 dark:bg-gray-700 px-1 rounded border border-gray-200 dark:border-gray-600">⌘</span>
            <span className="bg-gray-100 dark:bg-gray-700 px-1 rounded border border-gray-200 dark:border-gray-600">K</span>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-1.5 scrollbar-custom">
        <div className="px-2 mb-3 space-y-1">
          <button onClick={() => setView('tasks')} className={`w-full flex min-h-8 items-center gap-2 px-2 py-1 rounded-md transition-colors text-left focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'tasks' ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200'}`}>
            <Inbox className="w-4 h-4" /> Tasks
          </button>
          {view === 'tasks' && (
            <div className="grid grid-cols-2 gap-1 pl-7 pr-1">
              {filters.map((filter) => (
                <button key={filter.key} onClick={() => setTaskFilter(filter.key)} className={`px-2 py-1 rounded text-[11px] text-left focus-visible:ring-2 focus-visible:ring-blue-500 ${taskFilter === filter.key ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                  {filter.label} <span className="text-gray-400">{taskCount(filter.key)}</span>
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setView('capabilities')} className={`w-full flex min-h-8 items-center gap-2 px-2 py-1 rounded-md transition-colors text-left focus-visible:ring-2 focus-visible:ring-blue-500 ${view === 'capabilities' ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-200'}`}>
            <Boxes className="w-4 h-4" /> Capabilities
          </button>
        </div>

        <div className="px-4 mb-5">
          <div className="flex items-center justify-between text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
            <span>Progress</span>
            <span>{progressPercentage}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-1.5">
            <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500 ease-out" style={{ width: `${progressPercentage}%` }}></div>
          </div>
          <div className="text-[10px] text-gray-400 mt-1.5">
            {completedTasks} of {totalTasks} features completed · {connected ? 'live' : 'offline'}
          </div>
        </div>

        <div className="mb-4">
          <button onClick={() => setWorkspaceOpen((open) => !open)} className="w-full px-4 py-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300 focus-visible:ring-2 focus-visible:ring-blue-500">
            {workspaceOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Workspace
          </button>

          {workspaceOpen && Object.entries(projects).flatMap(([, teamProjects]) => teamProjects).map((proj) => {
            const isActive = proj.id === currentProject?.id;
            const open = openProjects[proj.id] ?? isActive;
            const projectTasks = tasks.filter((task) => task.properties.project.id === proj.id);
            const planCount = projectTasks.filter((task) => task.contextBundle.spec.startsWith('plans/')).length;
            const agentCount = projectTasks.filter((task) => /active agent/.test(task.contextBundle.downstream)).length;
            return (
              <div key={proj.id} className="mt-2">
                <button onClick={() => setOpenProjects((state) => ({ ...state, [proj.id]: !open }))} className={`w-full flex min-h-8 items-center justify-between px-4 py-1 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${isActive ? 'text-gray-900 dark:text-gray-100 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                  <span className="flex items-center gap-2 min-w-0">
                    {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    <span className={`w-2 h-2 rounded-full ${proj.colorClass}`}></span>
                    <span className="truncate w-28">{proj.name}</span>
                  </span>
                  <span className="text-[10px] text-gray-400">{proj.shortCode}</span>
                </button>
                {open && (
                  <div className="ml-8 mt-1 space-y-1 text-xs text-gray-500 dark:text-gray-400">
                    <div className="flex items-center gap-2"><ListChecks className="w-3 h-3" /> Features <span className="text-gray-400">{projectTasks.length}</span></div>
                    <div className="flex items-center gap-2"><ChevronRight className="w-3 h-3" /> Plans <span className="text-gray-400">{planCount}</span></div>
                    <div className="flex items-center gap-2"><ChevronRight className="w-3 h-3" /> Agents <span className="text-gray-400">{agentCount}</span></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-gray-200 dark:border-gray-800">
        <button
          onClick={exportTasks}
          className="w-full flex min-h-9 items-center gap-2 px-3 py-2 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-200 transition-colors cursor-pointer border-b border-gray-200 dark:border-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <Download className="w-4 h-4" /> Export Snapshot
        </button>
        <div className="p-2.5">
          <div className="flex items-center justify-between text-gray-600 dark:text-gray-400">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-gray-700 text-white flex items-center justify-center text-xs">O</div>
              <span className="text-xs truncate w-32">{connected ? 'Daemon live' : 'Daemon offline'}</span>
            </div>
            <Settings className="w-4 h-4 text-gray-400" />
          </div>
        </div>
      </div>
    </aside>
  );
};
