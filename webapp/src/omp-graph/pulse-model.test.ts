import { describe, expect, test } from 'bun:test';
import { buildPulseModel, HOUR_MS, hourBins } from './pulse-model';
import type { GraphDoc } from './types';
import type { AgentDTO } from '../lib/dto';

const START = 1_000_000_000_000;
const doc = (over: Partial<GraphDoc> = {}): GraphDoc => ({
  range: { start: START, end: START + 24 * HOUR_MS },
  groups: [],
  tracks: [],
  sources: [],
  generatedAt: START + 12 * HOUR_MS,
  ...over,
});

const agent = (over: Partial<AgentDTO>): AgentDTO =>
  ({
    id: 'a1',
    name: 'unit',
    status: 'working',
    repo: '/r',
    worktree: '/w',
    pending: [],
    lastActivity: 0,
    autonomyMode: 'manual',
    effectiveMode: 'manual',
    verificationState: 'none',
    availableActions: [],
    ...over,
  }) as AgentDTO;

describe('hourBins', () => {
  test('bars and series bucket to hours from range.start', () => {
    const d = doc({
      tracks: [
        { id: 'git.commits', label: '', group: 'g', source: 's', type: 'bars', binMs: HOUR_MS, bins: [{ t: START + 2 * HOUR_MS, v: 3 }] },
        { id: 'receipts.cost', label: '', group: 'g', source: 's', type: 'series', points: [{ t: START + 2 * HOUR_MS + 5, v: 1.5 }] },
      ],
    });
    expect(hourBins(d, 'git.commits')[2]).toBe(3);
    expect(hourBins(d, 'receipts.cost')[2]).toBe(1.5);
    expect(hourBins(d, 'missing').every((v) => v === 0)).toBe(true);
  });
});

describe('buildPulseModel', () => {
  test('cumulative stops accruing at NOW; sessions pack into rows; live agents become pills', () => {
    const d = doc({
      tracks: [
        {
          id: 'receipts.cost', label: '', group: 'g', source: 's', type: 'series',
          points: [
            { t: START + 1 * HOUR_MS, v: 2 },
            { t: START + 20 * HOUR_MS, v: 9 }, // after NOW — must not accrue
          ],
        },
        {
          id: 'receipts.sessions', label: '', group: 'g', source: 's', type: 'spans',
          spans: [
            { t0: START, t1: START + 2 * HOUR_MS, label: 'r1', status: 'stopped' },
            { t0: START + HOUR_MS, t1: START + 3 * HOUR_MS, label: 'r2', status: 'error' },
          ],
        },
      ],
    });
    const m = buildPulseModel(d, [agent({ status: 'working', startedAt: START + 11 * HOUR_MS })]);
    expect(m.cum[m.bins - 1]).toBe(2);
    // overlapping receipts pack to different rows
    const rows = new Set(m.sessions.filter((s) => !s.live).map((s) => s.row));
    expect(rows.size).toBe(2);
    // the live agent runs to NOW
    const live = m.sessions.find((s) => s.live);
    expect(live?.t1).toBe(m.nowMs);
    expect(live?.status).toBe('working');
  });

  test('the imperative layer derives from the roster', () => {
    const m = buildPulseModel(doc(), [
      agent({ id: 'b', status: 'input', pending: [{ id: 'q1', source: 'ui', kind: 'input', title: 'overwrite shell?', createdAt: 0 }] }),
      agent({ id: 'r', status: 'idle', landReady: true }),
    ]);
    expect(m.needsCount).toBe(2);
    const kinds = m.below.map((e) => e.kind).sort();
    expect(kinds).toEqual(['BLOCKED', 'READY']);
    expect(m.below.find((e) => e.kind === 'BLOCKED')?.requestId).toBe('q1');
  });

  test('milestones carry sha and big-ness; closed tickets land below', () => {
    const d = doc({
      tracks: [
        {
          id: 'git.milestones', label: '', group: 'g', source: 's', type: 'events',
          marks: [
            { t: START + HOUR_MS, label: 'squad(x): land y', kind: 'land', value: 500, meta: { sha: 'abc1234', churn: 500 } },
            { t: START + 2 * HOUR_MS, label: 'docs: tiny', kind: 'docs', value: 2, meta: { sha: 'def5678', churn: 2 } },
          ],
        },
        {
          id: 'plane.closed', label: '', group: 'g', source: 's', type: 'events',
          marks: [{ t: START + 3 * HOUR_MS, label: 'OMPSQ-1 done', kind: 'done', meta: { id: 'OMPSQ-1' } }],
        },
      ],
    });
    const m = buildPulseModel(d, []);
    expect(m.milestones[0]).toMatchObject({ kind: 'LAND', sha: 'abc1234', big: true });
    expect(m.below.find((e) => e.kind === 'DONE')?.ticket).toBe('OMPSQ-1');
  });
});
