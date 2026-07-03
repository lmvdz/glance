/**
 * TaskListView — the main-area task board (Tasks view, nothing selected).
 *
 * A dense, full-width ROW list (Plane/Linear style). Each row is assembled from a
 * COLUMNS config of pluggable "slots" — Pin · ID · Title · Status · % · Agents —
 * so adding a column is one entry in the array. Grouped PINNED → IN PROGRESS →
 * PLANNED → DONE.
 *
 * The Status slot is a dropdown of Plane's canonical state groups (Backlog · Todo
 * · In Progress · Done · Cancelled). Selecting one updates the task optimistically;
 * persisting the change back to Plane for issue-backed tasks is a backend follow-up.
 *
 * Reuses the exact task→agent→status mapping the WorkbenchPane rail uses.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Inbox, Pin, Users } from 'lucide-react';
import { useTaskContext } from '../context/TaskContext';
import { summarizeTask, taskListRank, type TaskStatus } from '../lib/taskStatus';
import { taskRef } from '../lib/task-model';
import { getCategoryBadge } from '../utils';
import type { Task } from '../types';
import type { AgentDTO } from '../lib/dto';

// ── Plane's canonical state groups — the status dropdown options ───────────────
interface StatusOption { group: string; label: string; dot: string; text: string }
const TASK_STATUSES: StatusOption[] = [
  { group: 'backlog', label: 'Backlog', dot: 'bg-gray-400', text: 'text-gray-500 dark:text-gray-400' },
  { group: 'unstarted', label: 'Todo', dot: 'bg-blue-400', text: 'text-blue-500 dark:text-blue-400' },
  { group: 'started', label: 'In Progress', dot: 'bg-amber-500', text: 'text-amber-500' },
  { group: 'completed', label: 'Done', dot: 'bg-emerald-500', text: 'text-emerald-500' },
  { group: 'cancelled', label: 'Cancelled', dot: 'bg-red-400', text: 'text-red-400 dark:text-red-400' },
];
const byGroup = (g: string): StatusOption => TASK_STATUSES.find((s) => s.group === g) ?? TASK_STATUSES[0];
const currentStatus = (task: Task): StatusOption => {
  const byLabel = TASK_STATUSES.find((s) => s.label.toLowerCase() === (task.properties.status ?? '').toLowerCase());
  if (byLabel) return byLabel;
  return task.status === 'done' ? byGroup('completed') : task.status === 'active' ? byGroup('started') : byGroup('backlog');
};
const taskStatusForGroup = (g: string): Task['status'] => (g === 'completed' ? 'done' : g === 'started' ? 'active' : 'todo');

// ── avatars ──────────────────────────────────────────────────────────────────
const AVATAR_COLORS = ['bg-rose-500', 'bg-sky-500', 'bg-amber-500', 'bg-emerald-500', 'bg-violet-500', 'bg-pink-500', 'bg-cyan-500'];
const avatarColor = (name: string): string => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
};
const initials = (name: string): string => name.split(/[\s\-_./]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
const agentRing: Record<string, string> = { working: 'ring-emerald-500', starting: 'ring-emerald-500', error: 'ring-red-500', idle: 'ring-amber-400' };
const Avatar: React.FC<{ agent: AgentDTO }> = ({ agent }) => (
  <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-offset-1 ring-offset-white dark:ring-offset-gray-950 ${avatarColor(agent.name)} ${agentRing[agent.status] ?? 'ring-gray-400'}`} title={`${agent.name} · ${agent.status}`}>
    {initials(agent.name)}
  </span>
);

// ── the status dropdown cell ─────────────────────────────────────────────────
const StatusCell: React.FC<{ current: StatusOption; onChange: (s: StatusOption) => void }> = ({ current, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change status"
      >
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${current.dot}`} />
        <span className={current.text}>{current.label}</span>
        <ChevronDown className="h-3 w-3 text-gray-400" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900" role="listbox">
          {TASK_STATUSES.map((s) => (
            <button
              key={s.group}
              onClick={() => { onChange(s); setOpen(false); }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
              role="option"
              aria-selected={s.group === current.group}
            >
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${s.dot}`} />
              <span className={`${s.text} ${s.group === current.group ? 'font-semibold' : ''}`}>{s.label}</span>
              {s.group === current.group && <Check className="ml-auto h-3 w-3 text-gray-400" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── slot context + pluggable columns ─────────────────────────────────────────
interface SlotCtx {
  task: Task;
  status: TaskStatus;
  pinned: boolean;
  togglePin: () => void;
  onStatusChange: (s: StatusOption) => void;
}
interface TaskColumn {
  key: string;
  header: string;
  cell: string;
  render: (ctx: SlotCtx) => React.ReactNode;
}

const COLUMNS: TaskColumn[] = [
  {
    key: 'pin',
    header: '',
    cell: 'w-7 flex-shrink-0',
    render: ({ pinned, togglePin }) => (
      <button onClick={(e) => { e.stopPropagation(); togglePin(); }} className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 ${pinned ? 'text-amber-500' : 'text-gray-300 hover:text-gray-500 dark:text-gray-600'}`} title={pinned ? 'Unpin' : 'Pin to top'} aria-pressed={pinned}>
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
    cell: 'w-36 flex-shrink-0',
    render: ({ task, onStatusChange }) => <StatusCell current={currentStatus(task)} onChange={onStatusChange} />,
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
            <span className={`block h-1.5 rounded-full ${pct === 100 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
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
          <div className="flex -space-x-1.5">{on.slice(0, 3).map((a) => <Avatar key={a.id} agent={a} />)}</div>
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
  const { tasks, agents, selectTask, updateTask } = useTaskContext();
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const togglePin = (id: string): void => setPinned((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const changeStatus = (task: Task, s: StatusOption): void => updateTask(task.id, { status: taskStatusForGroup(s.group), properties: { ...task.properties, status: s.label } });

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

  const ctxFor = (t: Task): SlotCtx => ({ task: t, status: statusFor(t), pinned: pinned.has(t.id), togglePin: () => togglePin(t.id), onStatusChange: (s) => changeStatus(t, s) });
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
        <span className="ml-auto text-[11px] text-gray-400">click a row for full detail · click status to change</span>
      </div>

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
