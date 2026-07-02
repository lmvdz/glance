import React, { useState, useEffect } from 'react';
import { Layers, ChevronRight, PencilLine, List, Filter, Eye, Search, Circle, Plus, ArrowUp, GitPullRequest, CheckCircle2, Trash2, Mic, AlertCircle, GripVertical, Tag } from 'lucide-react';
import { getCategoryBadge } from '../utils';
import { useTaskContext } from '../context/TaskContext';

interface TaskListProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export const TaskList = ({ collapsed, onToggleCollapsed }: TaskListProps) => {
  const { tasks, currentProject, connected, selectedTaskId, selectTask, deleteTask, addTask, reorderTasks, taskFilter } = useTaskContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'creation' | 'dueDate'>('creation');
  const [isListening, setIsListening] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const allAvailableTags: string[] = Array.from(new Set(tasks.flatMap(t => t.tags || [])));

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
      alert("Speech recognition is not supported in this browser.");
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

  const isDueSoon = (dueDateStr?: string | null) => {
    if (!dueDateStr) return false;
    const dueDate = new Date(dueDateStr).getTime();
    const now = new Date().getTime();
    const diff = dueDate - now;
    return diff > 0 && diff <= 24 * 60 * 60 * 1000;
  };

  const filteredTasks = tasks.filter(task => {
    const showInCurrentView = taskFilter === 'all' || (taskFilter === 'done' ? task.status === 'done' : taskFilter === 'active' ? task.status === 'active' : task.status !== 'done');
    if (!showInCurrentView) return false;
    const matchesSearch = task.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          task.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || task.category === categoryFilter;
    const matchesTags = selectedTags.length === 0 || selectedTags.every(tag => task.tags?.includes(tag));
    
    return matchesSearch && matchesCategory && matchesTags;
  }).sort((a, b) => {
    if (sortBy === 'dueDate') {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    }
    return 0;
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIndex = filteredTasks.findIndex(t => t.id === selectedTaskId);
        if (currentIndex === -1) {
          if (filteredTasks.length > 0) selectTask(filteredTasks[0].id);
          return;
        }
        
        if (e.key === 'ArrowUp' && currentIndex > 0) {
          selectTask(filteredTasks[currentIndex - 1].id);
        } else if (e.key === 'ArrowDown' && currentIndex < filteredTasks.length - 1) {
          selectTask(filteredTasks[currentIndex + 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredTasks, selectedTaskId, selectTask]);

  const toggleTagFilter = (tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  const getPriorityColor = (priority: string | undefined | null) => {
    switch (priority) {
      case 'High': return 'bg-red-400';
      case 'Medium': return 'bg-amber-400';
      case 'Low': return 'bg-blue-400';
      default: return 'bg-gray-300';
    }
  };

  if (collapsed) {
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    return (
      <aside className="flex h-full w-10 flex-shrink-0 flex-col items-center border-r border-gray-200 bg-white py-1.5 dark:border-gray-800 dark:bg-gray-950">
        <button onClick={onToggleCollapsed} className="mb-1 flex min-h-9 w-9 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" aria-label="Expand task list pane" title="Expand task list pane">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="mt-2 flex h-full items-center">
          <div className="-rotate-90 whitespace-nowrap text-xs font-semibold uppercase tracking-widest text-gray-400">
            {filteredTasks.length} tasks{selectedTask ? ` · ${selectedTask.id}` : ''}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <div className="w-80 flex-shrink-0 flex flex-col h-full bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 z-20 transition-colors duration-200">
      {/* Top Header */}
      <div className="h-10 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-3 bg-gray-50/60 dark:bg-gray-950">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <div className="w-5 h-5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <Layers className="w-3 h-3" />
          </div>
          <span className="font-medium text-gray-700 dark:text-gray-200">glance</span>
          <ChevronRight className="w-3 h-3 text-gray-400" />
          <span className="truncate font-medium dark:text-gray-300">{currentProject?.name ?? 'No project'}</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 ${connected ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-gray-400'}`}></div> {connected ? 'LIVE' : 'OFFLINE'}
          </span>
          <PencilLine className="w-3 h-3 flex-shrink-0 text-gray-400 ml-1 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300" />
        </div>
        <button onClick={onToggleCollapsed} className="ml-2 flex min-h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-300" aria-label="Collapse task list pane" title="Collapse task list pane">
          <ChevronRight className="h-4 w-4 rotate-180" aria-hidden="true" />
        </button>
      </div>

      {/* Filters/Views */}
      <div className="h-9 border-b border-gray-200 dark:border-gray-800 flex items-center px-2 text-xs text-gray-600 dark:text-gray-400 overflow-x-auto gap-2 scrollbar-hide">
        <button className="px-2 h-full border-b-2 border-blue-500 text-blue-600 dark:text-blue-400 font-medium flex items-center gap-1 whitespace-nowrap">
          <List className="w-3 h-3" /> Structure
        </button>
        <div className="w-px h-4 bg-gray-200 dark:bg-gray-700"></div>
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-gray-400" /> 
          <select 
            className="bg-transparent border-none outline-none cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">All Categories</option>
            <option value="frontend">Frontend</option>
            <option value="backend">Backend</option>
            <option value="devops">DevOps</option>
            <option value="mcp">MCP</option>
            <option value="database">Database</option>
          </select>
        </div>
        <div className="flex items-center gap-1">
          <select 
            className="bg-transparent border-none outline-none cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'creation' | 'dueDate')}
          >
            <option value="creation">Sort by Creation</option>
            <option value="dueDate">Sort by Due Date</option>
          </select>
        </div>
      </div>

      {/* Search in List */}
      <div className="px-3 py-1.5 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400 w-3 h-3" />
          <input 
            type="text" 
            className="w-full pl-7 pr-2 py-1 bg-transparent dark:text-gray-200 text-xs focus:outline-none placeholder-gray-400" 
            placeholder="Search tasks by title or ID..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <button 
          onClick={handleVoiceToTask}
          className={`flex min-h-8 min-w-8 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${isListening ? 'bg-red-100 dark:bg-red-900/30 text-red-500 animate-pulse' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
          title="Voice to Task"
        >
          <Mic className="w-3.5 h-3.5" />
        </button>
      </div>
      
      {/* Tags Filter */}
      {allAvailableTags.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-800 flex items-center gap-1.5 overflow-x-auto scrollbar-hide flex-shrink-0">
          <Tag className="w-3 h-3 text-gray-400 flex-shrink-0 mr-1" />
          {allAvailableTags.map(tag => (
            <button
              key={tag}
              onClick={() => toggleTagFilter(tag)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 transition-colors ${selectedTags.includes(tag) ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-700' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* List Items */}
      <div className="flex-1 overflow-y-auto relative scrollbar-custom">
        {/* Group Header */}
        <div className="sticky top-0 bg-gray-50/95 dark:bg-gray-950/95 backdrop-blur z-10 px-3 py-1 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between group">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-400">
            <ChevronRight className="w-3 h-3 transform rotate-90 text-gray-400" />
            <span className="w-2 h-2 rounded-full border border-gray-400"></span>
            PLANNABLE
            <span className="text-gray-400 text-[10px] ml-1">{filteredTasks.length}</span>
          </div>
          <button onClick={handleCreateTask} className="flex min-h-8 min-w-8 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100">
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* Task Items */}
        <div className="flex flex-col text-xs">
          {filteredTasks.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-400 italic">No tasks match your search</div>
          ) : (
            filteredTasks.map(task => {
              const isActive = task.id === selectedTaskId;
              const isDone = task.status === 'done';
              const dueSoon = isDueSoon(task.dueDate) && !isDone;
              
              const isDraggable = sortBy === 'creation' && categoryFilter === 'all' && !searchQuery;

              return (
                <div 
                  key={task.id} 
                  draggable={isDraggable}
                  onDragStart={(e) => {
                    setDraggedTaskId(task.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedTaskId && draggedTaskId !== task.id) {
                       const draggedIdx = tasks.findIndex(t => t.id === draggedTaskId);
                       const targetIdx = tasks.findIndex(t => t.id === task.id);
                       if (draggedIdx !== -1 && targetIdx !== -1) {
                         reorderTasks(draggedIdx, targetIdx);
                       }
                    }
                    setDraggedTaskId(null);
                  }}
                  onClick={() => selectTask(task.id)}
                  className={`group flex min-h-11 items-center py-1 px-2 cursor-pointer border-b border-gray-100 dark:border-gray-800/50 transition-colors ${isActive ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-l-blue-500' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50 border-l-2 border-l-transparent'} ${draggedTaskId === task.id ? 'opacity-50' : 'opacity-100'}`}
                >
                  <div className={`w-3 flex justify-center ${isDraggable ? 'cursor-grab active:cursor-grabbing text-gray-300 opacity-0 group-hover:opacity-100' : 'opacity-0'} hover:text-gray-500`}>
                    <GripVertical className="w-3 h-3" />
                  </div>
                  <div className="w-5 flex justify-center flex-shrink-0 ml-0.5" title={`Status: ${task.properties.status}`}>
                    {isDone ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                    ) : (
                      <Circle className={`w-3.5 h-3.5 ${isActive ? 'text-blue-300 dark:text-blue-500' : 'text-gray-300 dark:text-gray-600'}`} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 px-2">
                    <div className={`truncate ${isDone ? 'line-through text-gray-400 dark:text-gray-600' : (isActive ? 'text-gray-900 dark:text-gray-100 font-medium' : 'text-gray-700 dark:text-gray-300')}`} title={task.title}>
                      {task.title}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      <span className={`max-w-[7rem] truncate font-medium ${isDone ? 'text-gray-400 dark:text-gray-600' : (isActive ? 'text-blue-700 dark:text-blue-400' : 'text-blue-600 dark:text-blue-500')}`} title={task.id}>
                        {task.id}
                      </span>
                      {dueSoon && (
                        <span title="Due within 24 hours" className="flex">
                          <AlertCircle className="w-3.5 h-3.5 text-red-500 animate-pulse" />
                        </span>
                      )}
                      {task.priority && (
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${getPriorityColor(task.priority)}`} title={`Priority: ${task.priority}`}></span>
                      )}
                      <span className={`max-w-[5.5rem] truncate px-1.5 py-0.5 rounded text-[10px] font-medium ${getCategoryBadge(task.category)}`}>
                        {task.category}
                      </span>
                    </div>
                  </div>
                  <div className="ml-1 flex w-12 flex-shrink-0 items-center justify-end gap-1">
                    <span className={`text-right ${isActive ? 'text-gray-500 dark:text-gray-400 font-medium' : 'text-gray-400 dark:text-gray-500'}`}>{task.duration}</span>
                    
                    <button 
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-all"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTask(task.id);
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
