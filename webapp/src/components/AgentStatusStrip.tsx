/**
 * AgentStatusStrip — the verdict-first header for a task/feature.
 *
 * Leads the TaskDetail pane with the answer to "is this okay, does it need me?"
 * and puts the ONE action right there: answer a blocked agent inline, restart an
 * errored/stopped one, or staff an unstaffed plan. The static authoring sections
 * (criteria, context bundle, decisions, relationships) move below it — this strip
 * is what you read first and, most days, all you need.
 *
 * Purely presentational: all state synthesis lives in lib/taskStatus.ts; the
 * answer/restart/implement handlers are owned by TaskDetail and passed down.
 */

import React, { useState } from 'react';
import { Bot, RotateCcw, CornerDownLeft, CircleDot } from 'lucide-react';
import { VerdictBadge, toneClasses } from './ui';
import type { TaskStatus } from '../lib/taskStatus';

export interface AgentStatusStripProps {
  status: TaskStatus;
  hasPlan: boolean;
  implementing: boolean;
  onAnswer: (agentId: string, requestId: string, value: string) => void;
  onRestart: (agentId: string) => void;
  onImplement: () => void;
}

/** Exported for reuse by other agent-status surfaces (e.g. TopologyPanel) that want the same
 *  status→color mapping without re-deriving it. */
export const STATUS_DOT: Record<string, string> = {
  working: 'bg-emerald-500',
  starting: 'bg-blue-500',
  input: 'bg-amber-500',
  idle: 'bg-sky-500',
  error: 'bg-red-500',
  stopped: 'bg-gray-400',
};

export const AgentStatusStrip: React.FC<AgentStatusStripProps> = ({ status, hasPlan, implementing, onAnswer, onRestart, onImplement }) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const t = toneClasses(status.verdict);

  const setAnswer = (id: string, v: string) => setAnswers((prev) => ({ ...prev, [id]: v }));
  const submit = (agentId: string, requestId: string) => {
    const value = answers[requestId]?.trim();
    if (!value) return;
    onAnswer(agentId, requestId, value);
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
  };

  const restartTargets = [...status.errored, ...status.stopped];

  return (
    <section className={`mb-6 overflow-hidden rounded-xl border ${t.border} ${t.softBg}`} aria-label="Agent status">
      {/* headline row */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <VerdictBadge verdict={status.verdict}>{status.posture === 'needs-you' ? 'Needs you' : status.posture === 'working' ? 'Working' : status.posture === 'idle' ? 'Idle' : 'Unstaffed'}</VerdictBadge>
          <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{status.headline}</span>
        </div>
        {status.criteria && status.criteria.total > 0 && (
          <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500 dark:text-gray-400" title="Acceptance criteria met">
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((100 * status.criteria.done) / status.criteria.total)}%` }} />
            </span>
            {status.criteria.done}/{status.criteria.total} criteria
          </span>
        )}
      </div>

      {/* agent chips */}
      {status.total > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          {[...status.blockers.map((b) => b.agent), ...status.errored, ...status.working, ...status.idle, ...status.stopped]
            .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i)
            .map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[a.status] ?? 'bg-gray-400'}`} aria-hidden="true" />
                {a.name}
              </span>
            ))}
        </div>
      )}

      {/* THE action — blocked: answer inline */}
      {status.blockers.length > 0 && (
        <div className="space-y-2 border-t border-amber-200/70 bg-white/60 px-4 py-3 dark:border-amber-900/40 dark:bg-gray-950/40">
          {status.blockers.flatMap((b) =>
            b.requests.map((req) => (
              <div key={req.id} className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
                <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  {b.agent.name} · {req.title}
                </div>
                {req.message && <p className="mt-1 whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300">{req.message}</p>}
                {req.options && req.options.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {req.options.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => onAnswer(b.agent.id, req.id, opt)}
                        className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800 dark:bg-gray-900 dark:text-amber-300 dark:hover:bg-amber-950/40"
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={answers[req.id] ?? ''}
                      onChange={(e) => setAnswer(req.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submit(b.agent.id, req.id);
                      }}
                      placeholder={req.placeholder ?? 'Type your answer…'}
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      className="flex-1 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs text-gray-800 placeholder:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800 dark:bg-gray-900 dark:text-gray-200"
                    />
                    <button
                      type="button"
                      onClick={() => submit(b.agent.id, req.id)}
                      disabled={!answers[req.id]?.trim()}
                      className="flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <CornerDownLeft className="h-3 w-3" aria-hidden="true" /> Send
                    </button>
                  </div>
                )}
              </div>
            )),
          )}
        </div>
      )}

      {/* THE action — errored/stopped: restart */}
      {status.blockers.length === 0 && restartTargets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-200/70 bg-white/60 px-4 py-3 dark:border-gray-800/70 dark:bg-gray-950/40">
          {restartTargets.map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              {a.status === 'error' && a.error && (
                <span className="max-w-xs truncate text-xs text-red-600 dark:text-red-400" title={a.error}>
                  {a.error}
                </span>
              )}
              <button
                type="button"
                onClick={() => onRestart(a.id)}
                className="flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:border-emerald-800 dark:bg-gray-900 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" /> Restart {a.name}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* THE action — unstaffed plan: implement */}
      {status.primaryAction === 'implement' && hasPlan && (
        <div className="flex items-center justify-between gap-3 border-t border-gray-200/70 bg-white/60 px-4 py-3 dark:border-gray-800/70 dark:bg-gray-950/40">
          <span className="text-xs text-gray-600 dark:text-gray-400">This plan is ready — kick off an implementation agent.</span>
          <button
            type="button"
            onClick={onImplement}
            disabled={implementing}
            className="flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
          >
            <Bot className="h-3.5 w-3.5" aria-hidden="true" /> {implementing ? 'Starting…' : 'Implement this plan'}
          </button>
        </div>
      )}

      {/* land-ready hint (action lives in the agent console) */}
      {status.primaryAction === 'land' && (
        <div className="flex items-center gap-2 border-t border-amber-200/70 bg-white/60 px-4 py-3 text-xs text-gray-600 dark:border-amber-900/40 dark:bg-gray-950/40 dark:text-gray-400">
          <CircleDot className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
          Verification passed — open the agent console to review the proof and land.
        </div>
      )}
    </section>
  );
};
