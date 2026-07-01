/**
 * TaskListView — the main-area task board (Tasks view, nothing selected).
 *
 * A dense, full-width ROW list (Plane/Linear style). Each row is assembled from a
 * COLUMNS config of pluggable "slots" — Pin · ID · Title · Status · % · Agents —
 * so adding a column is one entry in the array, nothing else changes. Grouped
 * PINNED → IN PROGRESS (active agents) → PLANNED → DONE.
 *
 * Reuses the exact task→agent→status mapping the WorkbenchPane rail uses.
 */

import React, { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleDashed, CircleDot, Inbox, Loader, Pin, Users } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { summarizeTask, taskListRank, type TaskStatus } from '../lib/taskStatus';
import { taskRef } from '../lib/task-model';
import { getCategoryBadge } from '../utils';
import type { Task } from '../types';
import type { AgentDTO } from '../lib/dto';

// ── slot context: everything a column render function may need ────────────────
interface SlotCtx {
  task: Task;
  status: TaskStatus;
  pinned: boolean;
  togglePin: () => void;
}
interface TaskColumn {
  key: string;
  header: string;
  /** width / alignment classes for both the header cell and the row cell. */
  cell: string;
  render: (ctx: SlotCtx) => React.ReactNode;
}

const AVATAR_COLORS = ['bg-rose-500', 'bg-sky-500', 'bg-amber-500', 'bg-emerald-500', 'bg-violet-500', 'bg-pink-500', 'bg-cyan-500'];
const avatarColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};
const initials = (name: string): string => name.split(/[\s\-_./]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
const agentRing: Record<string, string> = { working: 'ring-emerald-500', starting: 'ring-emerald-500', error: 'ring-red-500', idle: 'ring-amber-400' };

const Avatar: React.FC<{ agent: AgentDTO }> = ({ agent }) => (
  <span
    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-offset-1 ring-offset-white dark:ring-offset-gray-950 ${avatarColor(agent.name)} ${agentRing[agent.status] ?? 'ring-gray-400'}`}
    title={`${agent.name} · ${agent.status}`}
  >
    {initials(agent.name)}
  </span>
);

// ── the pluggable columns — extend by adding an entry ─────────────────────────
const COLUMNS: TaskColumn[] = [
  {
    key: 'pin',
    header: '',
    cell: 'w-7 flex-shrink-0',
    render: ({ pinned, togglePin }) => (
      <button
        onClick={(e) => { e.stopPropagation(); togglePin(); }}
        className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 ${pinned ? 'text-amber-500' : 'text-gray-300 hover:text-gray-500 dark:text-gray-600'}`}
        title={pinned ? 'Unpin' : 'Pin to top'}
        aria-pressed={pinned}
      >
        <Pin className={`h-3.5 w-3.5 ${pinned ? 'fill-amber-400' : ''}`} aria-hidden="true" />
      </button>
    ),
  },
  {
    key: 'id',
    header: 'ID',
    cell: 'w-24 flex-shrink-0',
    render: ({ task }) => <span className="truncate font-mono text-[11px] text-gray-400" title={task.planDir ?? task.id}>{taskRef(task) ?? task.id.slice(0, 8)}</span>,
  },
  {
    key: 'title',
    header: 'Title',
    cell: 'min-w-0 flex-1',
    render: ({ task }) => (
      <div className="flex min-w-0 items-center gap-2">
        <span className={`truncate text-sm ${task.status === 'done' ? 'text-gray-400 line-through dark:text-gray-600' : 'font-medium text-gray-900 dark:text-gray-100'}`} title={task.title}>{task.title}</span>
        <span className={`hidden flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium sm:inline ${getCategoryBadge(task.category)}`}>{task.category}</span>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: 'w-32 flex-shrink-0',
    render: ({ task, status }) => {
      const isDone = task.status === 'done';
      const [Icon, label, cls] = isDone
        ? [CheckCircle2, 'Done', 'text-blue-500']
        : status.posture === 'working'
          ? [Loader, 'In progress', 'text-emerald-500']
          : status.posture === 'needs-you'
            ? [AlertCircle, status.verdict === 'critical' ? 'Blocked' : 'Ready', status.verdict === 'critical' ? 'text-red-500' : 'text-amber-500']
            : status.posture === 'idle'
              ? [CircleDot, 'Stopped', 'text-amber-400']
              : [CircleDashed, 'Backlog', 'text-gray-400'];
      return (
        <span className={`inline-flex items-center gap-1.5 text-xs ${cls}`}>
          <Icon className={`h-3.5 w-3.5 ${status.posture === 'working' ? 'animate-spin [animation-duration:3s]' : ''}`} aria-hidden="true" />
          {label}
        </span>
      );
    },
  },
  {
    key: 'completion',
    header: '%',
    cell: 'w-28 flex-shrink-0',
    render: ({ task }) => {
      const total = task.acceptanceCriteria.length;
      if (total === 0) return <span className="text-xs text-gray-300 dark:text-gray-700">—</span>;
      const done = task.acceptanceCriteria.filter((c) => c.completed).length;
      const pct = Math.round((done / total) * 100);
      return (
        <div className="flex items-center gap-2" title={`${done}/${total} acceptance criteria`}>
          <span className="h-1.5 w-14 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
            <span className={`block h-1.5 rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="font-mono text-[10px] text-gray-400">{pct}%</span>
        </div>
      );
    },
  },
  {
    key: 'agents',
    header: 'Agents',
    cell: 'w-24 flex-shrink-0',
    render: ({ status }) => {
      const on = [...status.working, ...status.errored, ...status.idle, ...status.stopped];
      if (!on.length) return <Users className="h-3.5 w-3.5 text-gray-300 dark:text-gray-700" aria-hidden="true" />;
      return (
        <div className="flex items-center">
          <div className="flex -space-x-1.5">
            {on.slice(0, 3).map((a) => <Avatar key={a.id} agent={a} />)}
          </div>
          {on.length > 3 && <span className="ml-1 text-[10px] text-gray-400">+{on.length - 3}</span>}
        </div>
      );
    },
  },
];

const TaskRow: React.FC<{ ctx: SlotCtx; onSelect: () => void }> = ({ ctx, onSelect }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onSelect}
    onKeyDown={(e) => { if (e.key === 'Enter') onSelect(); }}
    className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-4 py-2.5 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 dark:border-gray-800/60 dark:hover:bg-gray-900/60 dark:focus-visible:bg-gray-900/60"
  >
    {COLUMNS.map((col) => (
      <div key={col.key} className={`flex items-center ${col.cell}`}>{col.render(ctx)}</div>
    ))}
  </div>
);

const SectionHeader: React.FC<{ title: string; count: number; hint?: string; tone?: string }> = ({ title, count, hint, tone }) => (
  <div className="flex items-baseline gap-2 border-b border-gray-200 bg-gray-50 px-4 py-1.5 dark:border-gray-800 dark:bg-gray-900/40">
    <h2 className={`text-[11px] font-semibold uppercase tracking-widest ${tone ?? 'text-gray-500'}`}>{title}</h2>
    <span className="font-mono text-[11px] text-gray-400">{count}</span>
    {hint && <span className="text-[11px] text-gray-400">· {hint}</span>}
  </div>
);

export const TaskListView: React.FC = () => {
  const { tasks, agents, selectTask } = useTaskContext();
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const togglePin = (id: string): void => setPinned((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

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

  const groups = useMemo(() => {
    const pin: Task[] = [];
    const inProgress: Task[] = [];
    const planned: Task[] = [];
    const done: Task[] = [];
    for (const t of tasks) {
      if (pinned.has(t.id)) pin.push(t);
      else if (t.status === 'done') done.push(t);
      else if ((statuses.get(t.id)?.total ?? 0) > 0) inProgress.push(t);
      else planned.push(t);
    }
    inProgress.sort((a, b) => taskListRank(statusFor(a), false) - taskListRank(statusFor(b), false));
    return { pin, inProgress, planned, done };
  }, [tasks, statuses, pinned]);

  const ctxFor = (t: Task): SlotCtx => ({ task: t, status: statusFor(t), pinned: pinned.has(t.id), togglePin: () => togglePin(t.id) });
  const total = tasks.length;

  const renderSection = (title: string, list: Task[], tone?: string, hint?: string): React.ReactNode =>
    list.length > 0 && (
      <div key={title}>
        <SectionHeader title={title} count={list.length} hint={hint} tone={tone} />
        {list.map((t) => <TaskRow key={t.id} ctx={ctxFor(t)} onSelect={() => selectTask(t.id)} />)}
      </div>
    );

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden bg-white dark:bg-gray-950">
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <Inbox className="h-4 w-4 text-blue-500" aria-hidden="true" />
        <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100">All work items</h1>
        <span className="font-mono text-xs text-gray-400">{total}</span>
        <span className="ml-auto text-[11px] text-gray-400">click a row for full detail</span>
      </div>

      {/* column header — same COLUMNS drive it, so cells stay aligned with the rows */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-1.5 dark:border-gray-800">
        {COLUMNS.map((col) => (
          <div key={col.key} className={`text-[10px] font-semibold uppercase tracking-wider text-gray-400 ${col.cell}`}>{col.header}</div>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-custom">
        {total === 0 ? (
          <div className="flex flex-col items-center gap-2 py-24 text-center text-gray-500 dark:text-gray-400">
            <Inbox className="h-8 w-8 text-gray-300 dark:text-gray-600" aria-hidden="true" />
            <div className="text-sm font-medium">No work items yet</div>
            <div className="text-xs">Plans and features land here as the fleet creates them.</div>
          </div>
        ) : (
          <>
            {renderSection('Pinned', groups.pin, 'text-amber-500')}
            {renderSection('In progress', groups.inProgress, 'text-emerald-500', 'active agents')}
            {renderSection('Planned', groups.planned)}
            {renderSection('Done', groups.done, 'text-blue-500')}
          </>
        )}
      </div>
    </main>
  );
};
