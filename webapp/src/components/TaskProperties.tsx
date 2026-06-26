import React, { useState } from 'react';
import { CircleDashed, Flag, User, Layers, Clock, Briefcase, Plus, X, ChevronDown } from 'lucide-react';
import { getCategoryBadge } from '../utils';
import { Task } from '../types';
import { useTaskContext } from '../context/TaskContext';

interface TaskPropertiesProps {
  task: Task;
}

export const TaskProperties = ({ task }: TaskPropertiesProps) => {
  const { updateTask } = useTaskContext();
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagText, setNewTagText] = useState('');

  const handleRemoveTag = (tagToRemove: string) => {
    updateTask(task.id, {
      tags: task.tags.filter(t => t !== tagToRemove)
    });
  };

  const handleAddTag = () => {
    if (newTagText.trim() && !task.tags.includes(newTagText.trim())) {
      updateTask(task.id, {
        tags: [...task.tags, newTagText.trim()]
      });
    }
    setNewTagText('');
    setIsAddingTag(false);
  };

  return (
    <aside className="w-64 flex-shrink-0 p-6 overflow-y-auto bg-[#f9f9fb] dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 scrollbar-custom transition-colors duration-200" data-purpose="task-properties">
      {/* Properties Section */}
      <div className="mb-8">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-4">Properties</div>
        <div className="space-y-3">
          <div className="flex items-center justify-between group">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <CircleDashed className="w-3.5 h-3.5" /> Status
            </div>
            <button className="px-2 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-xs text-gray-600 dark:text-gray-300 font-medium flex items-center gap-1 border border-gray-200 dark:border-gray-700 transition-colors">
              {task.properties.status} <ChevronDown className="w-3 h-3" />
            </button>
          </div>
          
          <div className="flex items-center justify-between group cursor-pointer">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Flag className="w-3.5 h-3.5" /> Priority
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-xs flex-1 text-right">{task.properties.priority || '—'}</div>
          </div>
          
          <div className="flex items-center justify-between group cursor-pointer">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <User className="w-3.5 h-3.5" /> Assignee
            </div>
            <div className="flex items-center gap-1 justify-end flex-1">
              <div className="w-4 h-4 rounded-full border border-dashed border-gray-300 dark:border-gray-700"></div>
              <span className="text-gray-400 dark:text-gray-500 text-xs">{task.properties.assignee || '—'}</span>
            </div>
          </div>
          
          <div className="flex items-center justify-between group cursor-pointer">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Layers className="w-3.5 h-3.5" /> Category
            </div>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 ${getCategoryBadge(task.category)}`}>
              {task.category} <ChevronDown className="w-2.5 h-2.5 opacity-50" />
            </span>
          </div>
          
          <div className="flex items-center justify-between group cursor-pointer">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Clock className="w-3.5 h-3.5" /> Due Date
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-xs flex-1 text-right">{task.dueDate || '—'}</div>
          </div>
          
          <div className="flex items-center justify-between group cursor-pointer">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Clock className="w-3.5 h-3.5" /> Estimate
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-xs flex-1 text-right">{task.properties.estimate || '—'}</div>
          </div>
          
          <div className="flex items-center justify-between group cursor-pointer">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Briefcase className="w-3.5 h-3.5" /> Project
            </div>
            <div className="text-gray-700 dark:text-gray-300 text-xs font-medium flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${task.properties.project.colorClass}`}></div> 
              {task.properties.project.name}
            </div>
          </div>
        </div>
      </div>

      {/* Tags Section */}
      <div className="mb-8">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
          Tags <span className="font-normal">{task.tags.length}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {task.tags.map(tag => (
            <span key={tag} className="px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded text-[10px] font-medium border border-indigo-100 dark:border-indigo-800/50 flex items-center gap-1 cursor-default transition-colors">
              {tag} <X className="w-2.5 h-2.5 opacity-50 hover:opacity-100 cursor-pointer" onClick={() => handleRemoveTag(tag)} />
            </span>
          ))}
          {isAddingTag ? (
            <input 
              autoFocus
              type="text"
              value={newTagText}
              onChange={e => setNewTagText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddTag();
                if (e.key === 'Escape') setIsAddingTag(false);
              }}
              onBlur={handleAddTag}
              className="px-1.5 py-0.5 w-20 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded text-[10px] font-medium border border-blue-300 focus:outline-none"
              placeholder="Tag name"
            />
          ) : (
            <button 
              onClick={() => setIsAddingTag(true)}
              className="px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded text-[10px] font-medium border border-dashed border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1 transition-colors"
            >
              <Plus className="w-2.5 h-2.5" /> Add
            </button>
          )}
        </div>
      </div>

      {/* Dependencies Section */}
      <div className="mb-8">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Dependencies</div>
        <div className="text-gray-400 text-xs italic">No files yet.</div>
      </div>

      {/* Files Section */}
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Files Touched</div>
        <div className="text-gray-400 text-xs italic">No files yet.</div>
      </div>
    </aside>
  );
};
