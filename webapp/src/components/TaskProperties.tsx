import React, { useState } from 'react';
import { CircleDashed, Flag, User, Layers, Clock, Briefcase, Plus, X } from 'lucide-react';
import { getCategoryBadge } from '../utils';
import { Task } from '../types';
import { useTaskContext } from '../context/TaskContext';

interface TaskPropertiesProps {
  task: Task;
}

/** Every value the category chip's select can pin — the full `Task['category']` union. */
export const CATEGORY_OPTIONS: Task['category'][] = ['frontend', 'backend', 'devops', 'mcp', 'database', 'other'];

export interface CategoryChipProps {
  /** The effective (resolved) category — override if set, else derived, else 'other'. Drives the badge tone. */
  category: Task['category'];
  /** The raw override, if one is set. `undefined` ⇒ the select shows "Auto" as selected. */
  override?: Task['category'];
  onChange: (category: Task['category'] | null) => void;
}

/**
 * The editable category chip — a native `<select>` styled to look like the existing read-only
 * badge (D1: "an EDITABLE category chip ... a small select/menu on the existing chip"). Choosing
 * "Auto" clears the override (`onChange(null)`); choosing an explicit value pins it. Kept pure
 * (no context) so it SSR-renders standalone for every state without a TaskProvider.
 */
export const CategoryChip: React.FC<CategoryChipProps> = ({ category, override, onChange }) => (
  <select
    aria-label="Category"
    value={override ?? ''}
    onChange={(event) => onChange((event.target.value || null) as Task['category'] | null)}
    className={`cursor-pointer appearance-none rounded border-0 px-1.5 py-0.5 text-[10px] font-medium outline-none focus:ring-2 focus:ring-amber-500/40 ${getCategoryBadge(category)}`}
  >
    <option value="">Auto · {category}</option>
    {CATEGORY_OPTIONS.map((option) => (
      <option key={option} value={option}>{option}</option>
    ))}
  </select>
);

export const TaskProperties = ({ task }: TaskPropertiesProps) => {
  const { updateTask, setTaskCategory } = useTaskContext();
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
          <div className="flex items-center justify-between">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <CircleDashed className="w-3.5 h-3.5" /> Status
            </div>
            <span className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-600 dark:text-gray-300 font-medium border border-gray-200 dark:border-gray-700">
              {task.properties.status}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Flag className="w-3.5 h-3.5" /> Priority
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-xs flex-1 text-right">{task.properties.priority || '—'}</div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <User className="w-3.5 h-3.5" /> Assignee
            </div>
            <div className="flex items-center gap-1 justify-end flex-1">
              <div className="w-4 h-4 rounded-full border border-dashed border-gray-300 dark:border-gray-700"></div>
              <span className="text-gray-400 dark:text-gray-500 text-xs">{task.properties.assignee || '—'}</span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Layers className="w-3.5 h-3.5" /> Category
            </div>
            <CategoryChip category={task.category} override={task.categoryOverride} onChange={(category) => setTaskCategory(task.id, category)} />
          </div>

          <div className="flex items-center justify-between">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Clock className="w-3.5 h-3.5" /> Due Date
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-xs flex-1 text-right">{task.dueDate || '—'}</div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-gray-500 dark:text-gray-400 text-xs flex items-center gap-2 w-24">
              <Clock className="w-3.5 h-3.5" /> Estimate
            </div>
            <div className="text-gray-400 dark:text-gray-500 text-xs flex-1 text-right">{task.properties.estimate || '—'}</div>
          </div>

          <div className="flex items-center justify-between">
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

      {task.proofProvenance?.readiness && (
        <div className="mb-8">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Promotion readiness</h3>
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
            <div className="font-semibold text-gray-900 dark:text-gray-100">{task.proofProvenance.readiness.state.replace(/-/g, ' ')}</div>
            <div className="mt-1">{task.proofProvenance.readiness.nextAction}</div>
          </div>
        </div>
      )}

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

      {/* Dependencies Section — the task's real linked work (relationships), not a placeholder. */}
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2">
          Dependencies <span className="font-normal">{task.relationships.length}</span>
        </div>
        {task.relationships.length === 0 ? (
          <div className="text-gray-400 text-xs italic">No linked work.</div>
        ) : (
          <div className="space-y-1.5">
            {task.relationships.map((rel) => (
              <div key={rel.id} className="flex items-baseline gap-1.5 text-xs" title={rel.targetTitle}>
                <span className="flex-shrink-0 font-medium text-gray-500 dark:text-gray-400">{rel.targetId}</span>
                <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">{rel.targetTitle}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};
