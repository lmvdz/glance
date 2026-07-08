// X3 owns this screen — stand-in, resolved at merge (feat/ui-design-review builds the real
// design-review loop: doc-anchored comments, the "N/M resolved" gate, agent doc-edit strike/insert
// rendering). This placeholder exists only so X2's "Create Design Discussion →" action has a route
// to land on while the two units are dispatched in parallel — merge order is X1 → X2 → X3, so this
// file is expected to be replaced wholesale when X3 lands, not incrementally reconciled.
import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';

export function DesignReviewView() {
  const { tasks, reviewTaskId, setView } = useTaskContext();
  const task = tasks.find((t) => t.id === reviewTaskId);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-white dark:bg-gray-950">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <button
          type="button"
          onClick={() => setView('tasks')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
        </button>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Design review</span>
        {task && <span className="text-xs text-gray-400">{task.title}</span>}
      </div>
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-gray-400 dark:text-gray-500">
        The design-review loop (doc-anchored comments, resolution gate, live agent edits) lands with
        feat/ui-design-review.
      </div>
    </main>
  );
}
