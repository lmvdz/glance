/**
 * TaskListView — the main-area task board shown in the Tasks view when nothing is
 * selected (instead of an empty "No task selected" screen). Richer than the
 * left-rail rows: each card carries the status headline, criteria progress, and
 * the live agents on it. Grouped by a hierarchy — IN PROGRESS (active agents)
 * first, then PLANNED, then DONE — so what's alive reads at the top.
 *
 * Reuses the exact task→agent→status mapping the WorkbenchPane rail uses.
 */

import React, { useMemo } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Circle, Inbox } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { summarizeTask, taskListRank, type TaskStatus } from '../lib/taskStatus';
import { taskRef } from '../lib/task-model';
import { getCategoryBadge } from '../utils';
import type { Task } from '../types';

const StatusGlyph: React.FC<{ status: TaskStatus; isDone: boolean }> = ({ status, isDone }) => {
  if (isDone) return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-blue-500" aria-hidden="true" />;
  if (status.posture === 'needs-you')
    return <AlertCircle className={`h-4 w-4 flex-shrink-0 ${status.verdict === 'critical' ? 'text-red-500' : 'text-amber-500'}`} aria-hidden="true" />;
  if (status.posture === 'working') return <span className="mt-0.5 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />;
  if (status.posture === 'idle') return <Circle className="h-4 w-4 flex-shrink-0 text-amber-400" aria-hidden="true" />;
  return <Circle className="h-4 w-4 flex-shrink-0 text-gray-300 dark:text-gray-600" aria-hidden="true" />;
};

const priorityDot: Record<string, string> = { High: 'bg-red-500', Medium: 'bg-amber-500', Low: 'bg-gray-400' };

const TaskCard: React.FC<{ task: Task; status: TaskStatus; onSelect: () => void }> = ({ task, status, onSelect }) => {
  const isDone = task.status === 'done';
  const ref = taskRef(task);
  const crit = status.criteria;
  const critPct = crit && crit.total > 0 ? Math.round((crit.done / crit.total) * 100) : null;
  return (
    <button
      onClick={onSelect}
      className="group flex w-full items-start gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-900/50 dark:hover:border-gray-700 dark:hover:bg-gray-900"
    >
      <StatusGlyph status={status} isDone={isDone} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate font-medium ${isDone ? 'text-gray-400 line-through dark:text-gray-600' : 'text-gray-900 dark:text-gray-100'}`} title={task.title}>
            {task.title}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {ref && <span className="font-medium text-blue-600 dark:text-blue-400" title={task.planDir ?? task.id}>{ref}</span>}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getCategoryBadge(task.category)}`}>{task.category}</span>
          {task.priority && <span className="flex items-center gap-1 text-gray-400"><span className={`h-1.5 w-1.5 rounded-full ${priorityDot[task.priority] ?? 'bg-gray-400'}`} />{task.priority}</span>}
          {critPct !== null && (
            <span className="flex items-center gap-1 text-gray-400" title={`${crit!.done} of ${crit!.total} acceptance criteria`}>
              <span className="h-1 w-10 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
                <span className="block h-1 rounded-full bg-blue-500" style={{ width: `${critPct}%` }} />
              </span>
              {crit!.done}/{crit!.total}
            </span>
          )}
        </div>
        {!isDone && status.headline && (
          <div className={`mt-1.5 text-xs ${status.verdict === 'critical' ? 'text-red-600 dark:text-red-400' : status.verdict === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}`}>{status.headline}</div>
        )}
        {status.working.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {status.working.slice(0, 4).map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {a.name}
              </span>
            ))}
            {status.working.length > 4 && <span className="text-[10px] text-gray-400">+{status.working.length - 4}</span>}
          </div>
        )}
      </div>
      <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-300 transition-colors group-hover:text-gray-500 dark:text-gray-600" aria-hidden="true" />
    </button>
  );
};

const Section: React.FC<{ title: string; hint?: string; tasks: Task[]; statusFor: (t: Task) => TaskStatus; onSelect: (id: string) => void }> = ({ title, hint, tasks, statusFor, onSelect }) => {
  if (!tasks.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">{title}</h2>
        <span className="font-mono text-[11px] text-gray-400">{tasks.length}</span>
        {hint && <span className="text-[11px] text-gray-400">· {hint}</span>}
      </div>
      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} status={statusFor(task)} onSelect={() => onSelect(task.id)} />
        ))}
      </div>
    </section>
  );
};

export const TaskListView: React.FC = () => {
  const { tasks, agents, selectTask } = useTaskContext();

  const statuses = useMemo(() => {
    const map = new Map<string, TaskStatus>();
    for (const task of tasks) {
      const featureId = task.sourceId ?? task.id;
      const taskAgents = agents.filter((a) => a.repo === task.properties.project.id && a.featureId === featureId);
      map.set(task.id, summarizeTask(taskAgents, { hasPlan: task.contextBundle.spec.startsWith('plans/') }));
    }
    return map;
  }, [tasks, agents]);
  const statusFor = (t: Task): TaskStatus => statuses.get(t.id) ?? summarizeTask([]);

  const { inProgress, planned, done } = useMemo(() => {
    const active: Task[] = [];
    const rest: Task[] = [];
    const finished: Task[] = [];
    for (const t of tasks) {
      if (t.status === 'done') finished.push(t);
      else if ((statuses.get(t.id)?.total ?? 0) > 0) active.push(t);
      else rest.push(t);
    }
    // active: needs-you first, then working, then idle (taskListRank)
    active.sort((a, b) => taskListRank(statusFor(a), false) - taskListRank(statusFor(b), false));
    return { inProgress: active, planned: rest, done: finished };
  }, [tasks, statuses]);

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950">
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <Inbox className="h-4 w-4 text-blue-500" aria-hidden="true" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Tasks</h1>
        <span className="text-xs text-gray-400">{inProgress.length} in progress · {planned.length} planned · {done.length} done</span>
        <span className="ml-auto text-[11px] text-gray-400">select a task for full detail</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 scrollbar-custom">
        <div className="mx-auto max-w-3xl space-y-6">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-20 text-center text-gray-500 dark:text-gray-400">
              <Inbox className="h-8 w-8 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              <div className="text-sm font-medium">No tasks yet</div>
              <div className="text-xs">Plans and features land here as the fleet creates them.</div>
            </div>
          ) : (
            <>
              <Section title="In progress" hint="active agents" tasks={inProgress} statusFor={statusFor} onSelect={selectTask} />
              <Section title="Planned" tasks={planned} statusFor={statusFor} onSelect={selectTask} />
              <Section title="Done" tasks={done} statusFor={statusFor} onSelect={selectTask} />
            </>
          )}
        </div>
      </div>
    </main>
  );
};
