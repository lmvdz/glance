import React from 'react';
import { useTaskContext } from '../../context/TaskContext';
import { summarizeTask } from '../../lib/taskStatus';
import { bands, whereYouHaveBeen, workHeadline, type WorkItem } from '../../lib/workSurface';
import { workbenchHref } from '../../lib/router';

/**
 * WorkSurface — what is on, in the order it needs you.
 *
 * `02-surfaces.html` never draws a task board. It draws **WHERE YOU HAVE BEEN STANDING TODAY** and
 * puts everything else behind the room's own tree — no status column, no percent-done, no assignee
 * avatars, because none of those is a thing a person acts on.
 *
 * This replaces a Plane/Linear board: a COLUMNS config of pluggable slots (Pin · ID · Title · Status ·
 * % · Agents) grouped PINNED → IN PROGRESS → PLANNED → DONE. That is a project-management tool for
 * humans assigning work to humans, on a product whose whole premise is that the fleet assigns work to
 * itself and stops only when it genuinely cannot proceed.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";
const TONE: Record<string, string> = { 'needs-you': '#D9A03C', working: '#3E5C8A', idle: '#4A4A52', settled: '#3E7D57' };

export function WorkSurface() {
  const { tasks, agents, selectTask } = useTaskContext();
  const now = Date.now();

  const items: WorkItem[] = React.useMemo(
    () => tasks.map((task) => {
      const mine = agents.filter((agent) => agent.featureId === task.id);
      const status = summarizeTask(mine, { hasPlan: !!task.planDir });
      return {
        id: task.id,
        title: task.title,
        headline: status.headline,
        posture: (status.posture === 'needs-you' ? 'needs-you' : status.posture === 'working' ? 'working' : task.status === 'done' ? 'settled' : 'idle') as WorkItem['posture'],
        verdict: status.verdict,
        done: task.status === 'done',
        // AgentDTO carries startedAt and no last-touched field, so "when did this last move" is the
        // most recent START among its units. That is an approximation and the surface treats it as
        // one — it only orders rows and gates the last-day recency list, never claims a time.
        lastActivity: mine.reduce((most, agent) => Math.max(most, agent.startedAt ?? 0), 0) || undefined,
        agentCount: mine.length,
      };
    }),
    [tasks, agents],
  );

  // Units attached to no task on this list. Without this the surface makes a claim about the FLEET
  // from task-scoped data, which is how it came to say "not one of them needs you" while the room's
  // own bar said "1 waiting on you".
  const unattached = React.useMemo(
    () => agents.filter((agent) => !agent.featureId || !tasks.some((task) => task.id === agent.featureId)).length,
    [agents, tasks],
  );
  const grouped = bands(items);
  const recent = whereYouHaveBeen(items, now);

  return (
    <div className="h-full overflow-y-auto" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="mx-auto max-w-[980px] px-8 py-9">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>WHAT IS ON</div>
        {/* Leads with what needs you. "18 tasks, 4 in progress" is the shape of a board and says
            nothing about whether you can close the tab. */}
        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ color: '#E8E8EA', textWrap: 'pretty', maxWidth: 720 }}>
          {workHeadline(items, unattached)}
        </div>

        <div className="mt-7 flex gap-9">
          <div className="min-w-0 flex-1">
            {grouped.map((band) => (
              <div key={band.label} className="mb-6">
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>{band.label} · {band.items.length}</div>
                <div className="mt-2 flex flex-col">
                  {band.items.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => { selectTask(entry.id); window.location.hash = workbenchHref('task', entry.id).slice(1); }}
                      className="flex gap-3 py-2.5 text-left"
                      style={{ borderTop: '1px solid #17171A' }}
                    >
                      <div className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full" style={{ background: TONE[entry.posture] ?? '#4A4A52' }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]" style={{ color: entry.done ? '#8A8A91' : '#DEDEE2' }}>{entry.title}</div>
                        {/* The headline is the row. A status word plus a percentage is two facts that
                            together still do not say whether anything is wrong. */}
                        {entry.headline ? (
                          <div className="mt-[3px] text-[11.5px] leading-[1.45]" style={{ color: '#8A8A91', textWrap: 'pretty' }}>{entry.headline}</div>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {grouped.length === 0 ? (
              <div className="text-[12.5px] leading-[1.5]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
                Nothing to list. Work started from the room's composer appears here as soon as it exists.
              </div>
            ) : null}
          </div>

          {recent.length > 0 ? (
            <div className="w-[280px] flex-none">
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>WHERE YOU HAVE BEEN STANDING TODAY</div>
              <div className="mt-2 flex flex-col">
                {recent.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => { selectTask(entry.id); window.location.hash = workbenchHref('task', entry.id).slice(1); }}
                    className="truncate py-1.5 text-left text-[12px]"
                    style={{ borderTop: '1px solid #17171A', color: '#C9C9CF' }}
                  >
                    {entry.title}
                  </button>
                ))}
              </div>
              {/* A history, not a menu: places you have not been do not appear here at all. */}
              <div className="mt-2 text-[11px] leading-[1.5]" style={{ color: '#4A4A52', textWrap: 'pretty' }}>
                Only the last day, and only things that actually moved. A list padded out with places you have never been
                would be a menu rather than a history.
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
