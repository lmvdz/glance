/**
 * taskStatus.ts — pure synthesis for the per-task (feature) view.
 *
 * Answers the only two questions a person actually has when they open a task:
 * "is this okay?" and "does it need me?" — by collapsing the agents working a
 * feature into ONE verdict + the ONE action that moves it forward. The TaskDetail
 * panel leads with this instead of burying live agent state below criteria,
 * context bundles, decisions, and relationships.
 *
 * Mirrors the insights.ts / heatmap.ts convention: no React, no fetch, no side
 * effects — trivially unit-testable, single source of truth for the strip.
 */

import type { AgentDTO, PendingRequest } from './dto';

export type TaskPosture = 'needs-you' | 'working' | 'idle' | 'unstaffed';

/** One agent that is blocked waiting on operator input, with its open requests. */
export interface TaskBlocker {
  agent: AgentDTO;
  requests: PendingRequest[];
}

export interface TaskStatus {
  posture: TaskPosture;
  /** maps to VerdictBadge tones. */
  verdict: 'critical' | 'warn' | 'healthy';
  /** the one-line answer to "is this okay / does it need me?". */
  headline: string;
  /** agents waiting on your answer (pending input). */
  blockers: TaskBlocker[];
  errored: AgentDTO[];
  stopped: AgentDTO[];
  working: AgentDTO[];
  idle: AgentDTO[];
  landReady: AgentDTO[];
  total: number;
  /** the single action that resolves the current posture. */
  primaryAction: 'answer' | 'restart' | 'land' | 'implement' | 'none';
  criteria?: { done: number; total: number };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Sort weight for a task in the left rail — lower floats to the top. Tasks that
 * need you rise; calm work sits; done sinks. Equal ranks keep their existing
 * order (callers rely on a stable sort), so this only *re-floats* what matters.
 */
export function taskListRank(status: TaskStatus, isDone: boolean): number {
  if (isDone) return 9;
  switch (status.posture) {
    case 'needs-you':
      return status.verdict === 'critical' ? 0 : 1; // blocked/errored, then ready-to-land
    case 'idle':
      return 2; // stopped — needs a restart-or-remove decision, so above calm work
    case 'working':
      return 3; // alive, nothing for you to do
    default:
      return 4; // unstaffed
  }
}

/**
 * Collapse the agents on a feature into a verdict + headline + primary action.
 * Priority, highest first: blocked-on-you / errored (critical) → ready-to-land
 * (warn) → working/idle (healthy) → stopped (warn) → unstaffed.
 */
export function summarizeTask(
  agents: AgentDTO[] | null | undefined,
  opts: { hasPlan?: boolean; criteria?: { done: number; total: number } } = {},
): TaskStatus {
  const list = agents ?? [];

  const blockers: TaskBlocker[] = list
    .filter((a) => (a.pending?.length ?? 0) > 0)
    .map((a) => ({ agent: a, requests: a.pending }));
  const blockedIds = new Set(blockers.map((b) => b.agent.id));

  const errored = list.filter((a) => a.status === 'error' && !blockedIds.has(a.id));
  const stopped = list.filter((a) => a.status === 'stopped');
  const working = list.filter((a) => a.status === 'working' || a.status === 'starting');
  const idle = list.filter((a) => a.status === 'idle' && !blockedIds.has(a.id));
  const landReady = list.filter((a) => a.landReady);

  let posture: TaskPosture;
  let verdict: TaskStatus['verdict'];
  let headline: string;
  let primaryAction: TaskStatus['primaryAction'];

  if (blockers.length || errored.length) {
    posture = 'needs-you';
    verdict = 'critical';
    primaryAction = blockers.length ? 'answer' : 'restart';
    if (blockers.length && errored.length) {
      headline = `${plural(blockers.length, 'agent')} waiting on you · ${plural(errored.length, 'agent')} errored`;
    } else if (blockers.length) {
      headline = `${plural(blockers.length, 'agent')} waiting on your answer`;
    } else {
      headline = `${plural(errored.length, 'agent')} errored — needs a restart`;
    }
  } else if (landReady.length) {
    posture = 'needs-you';
    verdict = 'warn';
    primaryAction = 'land';
    headline = `${plural(landReady.length, 'agent')} ready to land — review the proof`;
  } else if (working.length) {
    posture = 'working';
    verdict = 'healthy';
    primaryAction = 'none';
    headline = `${plural(working.length, 'agent')} working — nothing needs you`;
  } else if (idle.length) {
    posture = 'working';
    verdict = 'healthy';
    primaryAction = 'none';
    headline = `${plural(idle.length, 'agent')} idle — waiting between turns`;
  } else if (stopped.length) {
    posture = 'idle';
    verdict = 'warn';
    primaryAction = 'restart';
    headline = `${plural(stopped.length, 'agent')} stopped — restart or remove`;
  } else {
    posture = 'unstaffed';
    verdict = opts.hasPlan ? 'warn' : 'healthy';
    primaryAction = opts.hasPlan ? 'implement' : 'none';
    headline = opts.hasPlan ? 'No agent on this plan yet' : 'No agent assigned';
  }

  return {
    posture,
    verdict,
    headline,
    blockers,
    errored,
    stopped,
    working,
    idle,
    landReady,
    total: list.length,
    primaryAction,
    criteria: opts.criteria,
  };
}
