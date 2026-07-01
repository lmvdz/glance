/**
 * TaskListView — the main-area task board (Tasks view, nothing selected).
 *
 * A full-width, responsive board of rich plan cards — grouped IN PROGRESS (active
 * agents) → PLANNED → DONE. Each card leads with its content (description, live
 * acceptance-criteria progress, tags, the agents on it) and carries a
 * category-colored accent, so the board reads like a real workspace, not a list.
 *
 * Reuses the exact task→agent→status mapping the WorkbenchPane rail uses.
 */

import React, { useMemo } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, CircleDot, Inbox, ListChecks, Users } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { summarizeTask, taskListRank, type TaskStatus } from '../lib/taskStatus';
import { taskRef } from '../lib/task-model';
import { getCategoryBadge } from '../utils';
import type { Task } from '../types';

const CATEGORY_ACCENT: Record<string, string> = {
  frontend: 'border-l-rose-500',
  backend: 'border-l-sky-500',
  devops: 'border-l-amber-500',
  mcp: 'border-l-violet-500',
  database: 'border-l-emerald-500',
};
const priorityDot: Record<string, string> = { High: 'bg-red-500', Medium: 'bg-amber-500', Low: 'bg-gray-400' };

const timeAgo = (ms?: number): string => {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const StatusGlyph: React.FC<{ status: TaskStatus; isDone: boolean }> = ({ status, isDone }) => {
  if (isDone) return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-blue-500" aria-hidden="true" />;
  if (status.posture === 'needs-you') return <AlertCircle className={`h-4 w-4 flex-shrink-0 ${status.verdict === 'critical' ? 'text-red-500' : 'text-amber-500'}`} aria-hidden="true" />;
  if (status.posture === 'working') return <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60 animate-pulse" aria-hidden="true" />;
  if (status.posture === 'idle') return <CircleDot className="h-4 w-4 flex-shrink-0 text-amber-400" aria-hidden="true" />;
  return <CircleDot className="h-4 w-4 flex-shrink-0 text-gray-300 dark:text-gray-600" aria-hidden="true" />;
};

const TaskCard: React.FC<{ task: Task; status: TaskStatus; onSelect: () => void }> = ({ task, status, onSelect }) => {
  const isDone = task.status === 'done';
  const ref = taskRef(task);
  const done = task.acceptanceCriteria.filter((c) => c.completed).length;
  const total = task.acceptanceCriteria.length;
  const critPct = total > 0 ? Math.round((done / total) * 100) : 0;
  const accent = CATEGORY_ACCENT[task.category] ?? 'border-l-gray-400';
  const updated = timeAgo(task.properties.updatedAt);

  return (
    <button
      onClick={onSelect}
      className={`group relative flex flex-col rounded-xl border border-l-2 ${accent} border-gray-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-800 dark:bg-gray-900/50 dark:shadow-none dark:hover:border-gray-700 dark:hover:bg-gray-900`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusGlyph status={status} isDone={isDone} />
          <h3 className={`truncate text-sm font-semibold ${isDone ? 'text-gray-400 line-through dark:text-gray-600' : 'text-gray-900 dark:text-gray-100'}`} title={task.title}>
            {task.title}
          </h3>
        </div>
        <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-500 dark:text-gray-600" aria-hidden="true" />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {ref && <span className="font-medium text-blue-600 dark:text-blue-400" title={task.planDir ?? task.id}>{ref}</span>}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getCategoryBadge(task.category)}`}>{task.category}</span>
        {task.priority && (
          <span className="flex items-center gap-1 text-gray-400">
            <span className={`h-1.5 w-1.5 rounded-full ${priorityDot[task.priority] ?? 'bg-gray-400'}`} />
            {task.priority}
          </span>
        )}
      </div>

      {task.description && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{task.description}</p>}

      {total > 0 && (
        <div className="mt-3 flex items-center gap-2" title={`${done} of ${total} acceptance criteria met`}>
          <ListChecks className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
            <span className={`block h-1.5 rounded-full ${critPct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${critPct}%` }} />
          </span>
          <span className="flex-shrink-0 font-mono text-[10px] text-gray-400">{done}/{total}</span>
        </div>
      )}

      {task.tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {task.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">{tag}</span>
          ))}
          {task.tags.length > 4 && <span className="text-[10px] text-gray-400">+{task.tags.length - 4}</span>}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2.5 text-[11px] dark:border-gray-800/70">
        <div className="flex min-w-0 items-center gap-1.5">
          {status.working.length > 0 ? (
            <>
              <Users className="h-3 w-3 flex-shrink-0 text-emerald-500" aria-hidden="true" />
              <span className="truncate text-emerald-600 dark:text-emerald-400">
                {status.working.slice(0, 2).map((a) => a.name).join(', ')}
                {status.working.length > 2 ? ` +${status.working.length - 2}` : ''}
              </span>
            </>
          ) : !isDone && status.posture === 'needs-you' ? (
            <span className={`truncate ${status.verdict === 'critical' ? 'text-red-500' : 'text-amber-500'}`}>{status.headline}</span>
          ) : !isDone && status.posture === 'idle' ? (
            <span className="text-amber-500">stopped — needs a decision</span>
          ) : isDone ? (
            <span className="text-gray-400">completed</span>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">unstaffed · ready</span>
          )}
        </div>
        {updated && <span className="flex-shrink-0 text-gray-400 dark:text-gray-500">{updated}</span>}
      </div>
    </button>
  );
};

const Section: React.FC<{ title: string; hint?: string; tone?: string; cols: string; tasks: Task[]; statusFor: (t: Task) => TaskStatus; onSelect: (id: string) => void }> = ({ title, hint, tone, cols, tasks, statusFor, onSelect }) => {
  if (!tasks.length) return null;
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className={`text-[11px] font-semibold uppercase tracking-widest ${tone ?? 'text-gray-400'}`}>{title}</h2>
        <span className="font-mono text-[11px] text-gray-400">{tasks.length}</span>
        {hint && <span className="text-[11px] text-gray-400">· {hint}</span>}
      </div>
      <div className={`grid gap-3 ${cols}`}>
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
    active.sort((a, b) => taskListRank(statusFor(a), false) - taskListRank(statusFor(b), false));
    return { inProgress: active, planned: rest, done: finished };
  }, [tasks, statuses]);

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden bg-gray-50 dark:bg-gray-950">
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-gray-200 bg-white px-5 py-3 dark:border-gray-800 dark:bg-gray-950">
        <Inbox className="h-4 w-4 text-blue-500" aria-hidden="true" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Tasks</h1>
        <span className="text-xs text-gray-400">{inProgress.length} in progress · {planned.length} planned · {done.length} done</span>
        <span className="ml-auto text-[11px] text-gray-400">select any card for full detail</span>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-custom">
        <div className="mx-auto max-w-[1600px] space-y-8">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center text-gray-500 dark:text-gray-400">
              <Inbox className="h-8 w-8 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              <div className="text-sm font-medium">No tasks yet</div>
              <div className="text-xs">Plans and features land here as the fleet creates them.</div>
            </div>
          ) : (
            <>
              <Section title="In progress" hint="active agents" tone="text-emerald-500" cols="grid-cols-1 xl:grid-cols-2" tasks={inProgress} statusFor={statusFor} onSelect={selectTask} />
              <Section title="Planned" cols="grid-cols-1 md:grid-cols-2 2xl:grid-cols-3" tasks={planned} statusFor={statusFor} onSelect={selectTask} />
              <Section title="Done" tone="text-blue-500" cols="grid-cols-1 md:grid-cols-2 2xl:grid-cols-3" tasks={done} statusFor={statusFor} onSelect={selectTask} />
            </>
          )}
        </div>
      </div>
    </main>
  );
};
