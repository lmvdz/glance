import React from 'react';
import { ChevronRight, Check } from 'lucide-react';
import type { TodoPhaseDTO, TodoStatus } from '../../lib/dto';

// Moved verbatim from AssistantChat.tsx (concern 09 — monolith split).

const todoDotStyle: Record<TodoStatus, string> = {
  completed: 'border-emerald-500 bg-emerald-500 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-emerald-950',
  in_progress: 'border-blue-500 bg-blue-500 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-blue-950',
  pending: 'border-gray-300 bg-transparent text-transparent dark:border-gray-700',
};

export const TodoPanel = ({ phases, collapsed, onToggle }: { phases: TodoPhaseDTO[]; collapsed: boolean; onToggle: () => void }) => {
  const tasks = phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })));
  if (!tasks.length) return null;
  const done = tasks.filter((task) => task.status === 'completed').length;
  const active = tasks.find((task) => task.status === 'in_progress');
  const pct = Math.round((done / tasks.length) * 100);

  return (
    <section className="flex-shrink-0 border-b border-gray-200 bg-white/95 dark:border-gray-800 dark:bg-gray-950/95">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-10 w-full items-center gap-2 px-4 py-2 text-left hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:hover:bg-gray-900 dark:focus-visible:ring-offset-gray-950"
        aria-expanded={!collapsed}
      >
        <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 text-gray-500 transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Todo</span>
            {active && <span className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">{active.content}</span>}
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div className="h-full rounded-full bg-amber-500 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:bg-gray-900 dark:text-gray-300">{done}/{tasks.length}</span>
      </button>
      {!collapsed && (
        <div className="space-y-2 px-4 pb-3">
          {phases.map((phase) => (
            <div key={phase.name}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{phase.name}</div>
              <div className="space-y-1">
                {phase.tasks.map((task) => (
                  <div key={`${phase.name}:${task.content}`} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <span className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border ${todoDotStyle[task.status]}`}>
                      {task.status === 'completed' ? <Check className="h-2.5 w-2.5" aria-hidden /> : task.status === 'in_progress' ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
                    </span>
                    <span className={`truncate ${task.status === 'completed' ? 'text-gray-400 line-through decoration-current/40 dark:text-gray-500' : ''}`}>{task.content}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
