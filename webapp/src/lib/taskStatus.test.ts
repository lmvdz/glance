/**
 * taskStatus.test.ts — the pure per-task synthesis. DOM-free (bun:test).
 */

import { expect, test, describe } from 'bun:test';
import { summarizeTask, taskListRank } from './taskStatus';
import type { AgentDTO, PendingRequest } from './dto';

function agent(id: string, status: AgentDTO['status'], extra: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: `Agent ${id}`,
    status,
    repo: '/repo',
    worktree: '/wt',
    pending: [],
    lastActivity: 0,
    ...extra,
  } as AgentDTO;
}

function req(id: string): PendingRequest {
  return { id, source: 'tool', kind: 'ask', title: 'Pick one', createdAt: 0 };
}

describe('summarizeTask', () => {
  test('no agents + a plan → unstaffed, implement is the action', () => {
    const s = summarizeTask([], { hasPlan: true });
    expect(s.posture).toBe('unstaffed');
    expect(s.verdict).toBe('warn');
    expect(s.primaryAction).toBe('implement');
    expect(s.headline).toBe('No agent on this plan yet');
  });

  test('no agents + no plan → unstaffed, nothing to do', () => {
    const s = summarizeTask([], { hasPlan: false });
    expect(s.posture).toBe('unstaffed');
    expect(s.verdict).toBe('healthy');
    expect(s.primaryAction).toBe('none');
  });

  test('a working agent → healthy, nothing needs you', () => {
    const s = summarizeTask([agent('a', 'working')], { hasPlan: true });
    expect(s.posture).toBe('working');
    expect(s.verdict).toBe('healthy');
    expect(s.primaryAction).toBe('none');
    expect(s.headline).toBe('1 agent working — nothing needs you');
    expect(s.working).toHaveLength(1);
  });

  test('a blocked agent (pending input) → critical, answer is the action', () => {
    const s = summarizeTask([agent('a', 'input', { pending: [req('r1')] })], { hasPlan: true });
    expect(s.posture).toBe('needs-you');
    expect(s.verdict).toBe('critical');
    expect(s.primaryAction).toBe('answer');
    expect(s.blockers).toHaveLength(1);
    expect(s.blockers[0].requests[0].id).toBe('r1');
    expect(s.headline).toBe('1 agent waiting on your answer');
  });

  test('an errored agent → critical, restart is the action', () => {
    const s = summarizeTask([agent('a', 'error', { error: 'boom' })], { hasPlan: true });
    expect(s.verdict).toBe('critical');
    expect(s.primaryAction).toBe('restart');
    expect(s.errored).toHaveLength(1);
    expect(s.headline).toContain('errored');
  });

  test('blocked + errored → answer wins as the primary action, headline names both', () => {
    const s = summarizeTask(
      [agent('a', 'input', { pending: [req('r1')] }), agent('b', 'error')],
      { hasPlan: true },
    );
    expect(s.primaryAction).toBe('answer');
    expect(s.headline).toBe('1 agent waiting on you · 1 agent errored');
  });

  test('an agent that is both errored AND blocked counts only as a blocker', () => {
    const s = summarizeTask([agent('a', 'error', { pending: [req('r1')] })], { hasPlan: true });
    expect(s.blockers).toHaveLength(1);
    expect(s.errored).toHaveLength(0); // not double-counted
  });

  test('ready-to-land → warn, land is the action', () => {
    const s = summarizeTask([agent('a', 'idle', { landReady: true })], { hasPlan: true });
    expect(s.posture).toBe('needs-you');
    expect(s.verdict).toBe('warn');
    expect(s.primaryAction).toBe('land');
    expect(s.headline).toContain('ready to land');
  });

  test('only stopped agents → warn, restart is the action', () => {
    const s = summarizeTask([agent('a', 'stopped')], { hasPlan: true });
    expect(s.posture).toBe('idle');
    expect(s.verdict).toBe('warn');
    expect(s.primaryAction).toBe('restart');
  });

  test('blocked beats working when both are present', () => {
    const s = summarizeTask(
      [agent('a', 'working'), agent('b', 'input', { pending: [req('r1')] })],
      { hasPlan: true },
    );
    expect(s.verdict).toBe('critical');
    expect(s.primaryAction).toBe('answer');
  });

  test('passes criteria progress through untouched', () => {
    const s = summarizeTask([agent('a', 'working')], { hasPlan: true, criteria: { done: 2, total: 5 } });
    expect(s.criteria).toEqual({ done: 2, total: 5 });
  });

  test('null agents is safe', () => {
    expect(summarizeTask(null).total).toBe(0);
  });
});

describe('taskListRank', () => {
  const rankOf = (agents: AgentDTO[], isDone = false) => taskListRank(summarizeTask(agents, { hasPlan: true }), isDone);

  test('blocked/errored float to the very top', () => {
    expect(rankOf([agent('a', 'input', { pending: [req('r1')] })])).toBe(0);
    expect(rankOf([agent('a', 'error')])).toBe(0);
  });

  test('ready-to-land ranks just below critical; stopped above calm work', () => {
    expect(rankOf([agent('a', 'idle', { landReady: true })])).toBe(1);
    expect(rankOf([agent('a', 'stopped')])).toBe(2);
  });

  test('working sits below stopped, unstaffed below working', () => {
    expect(rankOf([agent('a', 'working')])).toBe(3);
    expect(rankOf([])).toBe(4);
  });

  test('done always sinks regardless of agent state', () => {
    expect(rankOf([agent('a', 'input', { pending: [req('r1')] })], true)).toBe(9);
  });

  test('orders a mixed backlog: blocked < stopped < working < unstaffed < done', () => {
    const ranks = [
      rankOf([agent('a', 'input', { pending: [req('r1')] })]),
      rankOf([agent('s', 'stopped')]),
      rankOf([agent('b', 'working')]),
      rankOf([]),
      rankOf([agent('c', 'working')], true),
    ];
    expect(ranks).toEqual([0, 2, 3, 4, 9]);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks); // already ascending
  });
});

describe('validator veto downgrades "ready to land"', () => {
  const veto = { verdict: 'veto' as const, agreement: 0, confidence: 0.9, perCriterion: [], rationale: 'nope' };
  test('a vetoed land-ready agent is CRITICAL "review", never a calm "ready to land"', () => {
    const s = summarizeTask([agent('a', 'idle', { landReady: true, validation: veto })]);
    expect(s.posture).toBe('needs-you');
    expect(s.verdict).toBe('critical');
    expect(s.headline).toContain('vetoed by the validator');
    expect(s.vetoed.map((a) => a.id)).toEqual(['a']);
    // and it floats to the very top of the rail (critical needs-you)
    expect(taskListRank(s, false)).toBe(0);
  });
  test('a land-ready agent with a PASS verdict stays the calm warn "ready to land"', () => {
    const pass = { ...veto, verdict: 'pass' as const };
    const s = summarizeTask([agent('a', 'idle', { landReady: true, validation: pass })]);
    expect(s.verdict).toBe('warn');
    expect(s.headline).toContain('ready to land');
    expect(s.vetoed).toHaveLength(0);
  });
});
