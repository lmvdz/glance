import { describe, expect, it } from 'bun:test';
import { acceptanceState, holdingIt, holdingNothingSentence, leftOutSentence, phases, reshapeSentence, shapeSentence, startedState, statusTone, type PlanConcern, type PlanShape } from './planSurface';

const concern = (over: Partial<PlanConcern> = {}): PlanConcern => ({
  file: '01.md', title: 'the parser', status: 'open', open: true, phase: 1, blockedBy: [], touches: [], acceptanceCount: 2, ...over,
});

describe('phases', () => {
  it('groups concerns that can run at the same time, in order', () => {
    const grouped = phases([concern({ phase: 2, file: 'c' }), concern({ phase: 1, file: 'a' }), concern({ phase: 1, file: 'b' })]);
    expect(grouped.map((g) => [g.phase, g.concerns.length])).toEqual([[1, 2], [2, 1]]);
  });
});

describe('shapeSentence', () => {
  it('counts the parallel units rather than making the reader count columns', () => {
    const line = shapeSentence([concern({ file: 'a', phase: 1 }), concern({ file: 'b', phase: 1 }), concern({ file: 'c', phase: 2 })]);
    expect(line).toBe('Three units, two of them in parallel.');
  });

  it('says plainly when nothing can run alongside anything', () => {
    expect(shapeSentence([concern({ file: 'a', phase: 1 }), concern({ file: 'b', phase: 2 })])).toContain('one after another');
  });

  it('does not describe an empty plan as a shape', () => {
    expect(shapeSentence([])).toContain('a title and an intention');
  });
});

describe('startedState', () => {
  it('claims nothing has started only when nothing has', () => {
    const fresh = startedState({ total: 6, open: 6, done: 0, blocked: 0 });
    expect(fresh.started).toBe(false);
    expect(fresh.line).toBe('NOTHING HAS STARTED');
    expect(fresh.meta).toContain('0 agents woken');
  });

  it('refuses to say nothing has started once work has moved', () => {
    // Telling someone they can still rename and reorder when four units have landed is the worst
    // thing this screen could do.
    const underway = startedState({ total: 6, open: 2, done: 4, blocked: 0 });
    expect(underway.started).toBe(true);
    expect(underway.line).not.toContain('NOTHING HAS STARTED');
    expect(underway.meta).toContain('4 done');
  });

  it('counts blocked work as movement, not as not-yet-started', () => {
    expect(startedState({ total: 3, open: 2, done: 0, blocked: 1 }).started).toBe(true);
  });
});

describe('reshapeSentence', () => {
  it('offers the reshape only before it starts', () => {
    expect(reshapeSentence(false)).toContain('not yours');
    expect(reshapeSentence(true)).toContain('no longer yours alone');
  });
});

describe('holdingIt', () => {
  const plan = (over: Partial<PlanShape> = {}): PlanShape => ({
    concerns: [], status: { total: 0, open: 0, done: 0, blocked: 0 }, outOfScope: [], dependencyIssues: [], touches: [], ...over,
  });

  it('puts sibling blocks and dependency problems in one list', () => {
    const held = holdingIt(plan({ concerns: [concern({ blockedBy: ['02'] })], dependencyIssues: ['dependency table did not parse'] }));
    expect(held).toEqual(['the parser — waiting on 02', 'dependency table did not parse']);
  });

  it('distinguishes an empty plan from an unblocked one', () => {
    expect(holdingNothingSentence(plan())).toContain('nothing is in it yet');
    expect(holdingNothingSentence(plan({ concerns: [concern()] }))).toContain('as soon as someone picks it up');
  });
});

describe('leftOutSentence', () => {
  it('treats an empty out-of-scope list as an absent line, not a full scope', () => {
    expect(leftOutSentence([])).toContain('nobody drew the line');
  });
  it('says why scope lives beside the plan', () => {
    expect(leftOutSentence(['the month-end run'])).toContain('scope you assume was included');
  });
});

describe('statusTone', () => {
  it('reads blocked as alarm and done as settled', () => {
    expect(statusTone(concern({ status: 'blocked' }))).toBe('#B4553A');
    expect(statusTone(concern({ open: false, status: 'done' }))).toBe('#3E7D57');
    expect(statusTone(concern())).toBe('#3E5C8A');
  });
});

describe('acceptanceState', () => {
  it('states a plan-wide gap once instead of on every row', () => {
    // Nine rows all reading "nothing to check it against" turns a real finding into wallpaper — the
    // reader stops seeing it by the third repetition.
    const state = acceptanceState([concern({ file: 'a', acceptanceCount: 0 }), concern({ file: 'b', acceptanceCount: 0 }), concern({ file: 'c', acceptanceCount: 0 })]);
    expect(state.perRow).toBe(false);
    expect(state.sentence).toContain('somebody’s judgement rather than a test');
  });

  it('goes back to per-row once some units have checks and some do not', () => {
    const state = acceptanceState([concern({ file: 'a', acceptanceCount: 3 }), concern({ file: 'b', acceptanceCount: 0 })]);
    expect(state.perRow).toBe(true);
    expect(state.sentence).toContain('1 of 2 units');
  });

  it('says nothing at all when every unit is covered', () => {
    const state = acceptanceState([concern({ file: 'a', acceptanceCount: 2 })]);
    expect(state.perRow).toBe(true);
    expect(state.sentence).toBeUndefined();
  });
});
