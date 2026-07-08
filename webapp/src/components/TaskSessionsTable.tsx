import React from 'react';
import type { AgentDTO } from '../lib/dto';
import { agentStatusBadgeClass } from '../lib/agent-badges';
import { deriveSessionType, type SessionType } from '../lib/sessionType';
import { fmtSince } from '../lib/factoryStatus';
import { StatusChip } from './kit/StatusChip';

export interface TaskSessionRow {
  id: string;
  name: string;
  status: AgentDTO['status'];
  type: SessionType;
  lastActivity: number;
}

/** Project the task's active agents into typed session rows, newest activity first — the ordering
 *  the reference uses (a running/just-updated session belongs at the top of its pipeline). */
export function sessionRowsFromAgents(agents: AgentDTO[]): TaskSessionRow[] {
  return agents
    .slice()
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status, type: deriveSessionType(agent), lastActivity: agent.lastActivity }));
}

/**
 * The human decision this table serves: "which of this task's sessions do I look at next, and what
 * kind of work is each one doing?" — reference A's core reframe of a task from a flat agent list into
 * a typed pipeline (Research → Design → Plan → Implementation → Verify). Clicking a row jumps to that
 * session's full control panel (still rendered below, in the existing per-agent detail block) rather
 * than duplicating stop/restart/fork controls here — this table is a map, not a second cockpit.
 */
export function TaskSessionsTable({ rows, onOpenSession }: { rows: TaskSessionRow[]; onOpenSession: (id: string) => void }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400 dark:border-gray-800 dark:text-gray-500">
        No sessions yet. Create Session to start the first one.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/60 text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-500">
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Session</th>
            <th className="px-3 py-2 text-right font-semibold">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onOpenSession(row.id)}
              className="cursor-pointer bg-white transition-colors hover:bg-gray-50 dark:bg-gray-950 dark:hover:bg-gray-900/60"
            >
              <td className="px-3 py-2 align-middle">
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase border ${agentStatusBadgeClass(row.status)}`}>{row.status}</span>
              </td>
              <td className="min-w-0 px-3 py-2 align-middle">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-gray-800 dark:text-gray-200">{row.name}</span>
                  <StatusChip tone="agent">{row.type}</StatusChip>
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-gray-400 dark:text-gray-500">
                {row.lastActivity ? fmtSince(Math.max(0, Math.floor((Date.now() - row.lastActivity) / 1000))) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
