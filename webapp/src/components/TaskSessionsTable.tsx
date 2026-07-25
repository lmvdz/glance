import React from 'react';
import type { AgentDTO } from '../lib/dto';
import { deriveSessionType, sessionTypeTone, type SessionType } from '../lib/sessionType';
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
      <div className="rounded-lg border border-dashed border-ink-border px-4 py-6 text-center text-xs text-ink-text-subtle border-ink-border text-ink-text0">
        No sessions yet. Create Session to start the first one.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-ink-border">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-ink-border bg-ink/60 text-caption font-semibold uppercase tracking-widest text-ink-text-subtle border-ink-border bg-panel/40 text-ink-text0">
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Session</th>
            <th className="px-3 py-2 text-right font-semibold">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-border divide-ink-border">
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onOpenSession(row.id)}
              className="cursor-pointer bg-white transition-colors hover:bg-ink dark:hover:bg-panel/60"
            >
              <td className="px-3 py-2 align-middle">
                {/* Kit chip = the universal state language (X1's KNOWN map: working→RUNNING solid
                    ember, input→NEEDS YOU, stopped→DONE dim) so session rows and the cockpit never
                    drift apart in vocabulary. */}
                <StatusChip status={row.status} />
              </td>
              <td className="min-w-0 px-3 py-2 align-middle">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-ink-text-body">{row.name}</span>
                  {/* Untyped "Session" renders muted (neutral tone) so a real derived type is
                      visually distinct from the honest fallback — the chip must not dress a
                      guess up as knowledge. */}
                  <StatusChip status={row.type} tone={sessionTypeTone(row.type)} />
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-ink-text-subtle">
                {row.lastActivity ? fmtSince(Math.max(0, Math.floor((Date.now() - row.lastActivity) / 1000))) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
