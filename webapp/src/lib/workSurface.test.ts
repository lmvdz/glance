import { describe, expect, it } from 'bun:test';
import { bandLabel, bands, ranked, whereYouHaveBeen, workHeadline, type WorkItem } from './workSurface';

const T = 1_000_000_000_000;
const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: 'a', title: 'a', headline: '', posture: 'working', verdict: 'healthy', done: false, lastActivity: T, agentCount: 1, ...over,
});

describe('ranked', () => {
  it('puts what needs you first and what is finished last', () => {
    const out = ranked([
      item({ id: 'done', done: true }), item({ id: 'idle', posture: 'idle' }),
      item({ id: 'needs', posture: 'needs-you' }), item({ id: 'work', posture: 'working' }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['needs', 'work', 'idle', 'done']);
  });

  it('breaks ties by what moved most recently', () => {
    const out = ranked([item({ id: 'old', lastActivity: T - 9999 }), item({ id: 'new', lastActivity: T })]);
    expect(out[0]!.id).toBe('new');
  });
});

describe('workHeadline', () => {
  it('leads with what needs you, not with a total', () => {
    // "18 tasks, 4 in progress" is the shape of a board and says nothing about closing the tab.
    const line = workHeadline([item({ posture: 'needs-you' }), item({ id: 'b' }), item({ id: 'c' })]);
    expect(line.startsWith('1 of the 3')).toBe(true);
  });

  it('says plainly when nothing needs you', () => {
    expect(workHeadline([item(), item({ id: 'b', posture: 'idle' })])).toContain('not one of them needs you');
  });

  it('distinguishes an empty list from a filtered one', () => {
    expect(workHeadline([])).toContain('not a filtered view');
  });

  it('does not describe finished work as on', () => {
    expect(workHeadline([item({ done: true })])).toContain('Everything here is finished');
  });
});

describe('bands', () => {
  it('names states of the world, not workflow columns', () => {
    expect(bandLabel('needs-you', false)).toBe('WAITING ON YOU');
    expect(bandLabel('idle', false)).toBe('ON, BUT NOT MOVING');
    expect(bandLabel('working', true)).toBe('FINISHED');
  });

  it('never draws a heading over nothing', () => {
    const out = bands([item({ posture: 'needs-you' }), item({ id: 'b', posture: 'needs-you' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.items).toHaveLength(2);
  });
});

describe('whereYouHaveBeen', () => {
  it('is a history, not a menu — only places actually visited today', () => {
    const out = whereYouHaveBeen([item({ id: 'today', lastActivity: T - 1000 }), item({ id: 'lastweek', lastActivity: T - 86_400_000 * 7 })], T);
    expect(out.map((i) => i.id)).toEqual(['today']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => item({ id: `i${i}`, lastActivity: T - i }));
    expect(whereYouHaveBeen(many, T, 3)).toHaveLength(3);
  });
});
