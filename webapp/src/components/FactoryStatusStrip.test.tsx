/**
 * FactoryStatusStrip.test.tsx — DOM-free tests for the strip's render helpers.
 *
 * Like the other panel tests, we don't mount the component (it needs fetch + timers). We verify the
 * pure display logic the strip depends on: status→visual mapping, the honest headline for each of the
 * four states, the reason line shown under each loop, and the heartbeat-age formatter.
 */

import { expect, test, describe } from 'bun:test';
import {
  STATUS_META,
  overallHeadline,
  loopReasonLine,
  fmtSince,
  type FactoryStatus,
  type FactoryLoopReport,
  type FactoryLoopStatus,
} from '../lib/factoryStatus';

function loop(status: FactoryLoopStatus, p: Partial<FactoryLoopReport> = {}): FactoryLoopReport {
  return {
    loop: 'dispatch',
    label: 'Dispatch',
    blurb: 'Polls the backlog.',
    flagEnabled: status !== 'off',
    armed: status === 'idle' || status === 'moving',
    stale: false,
    status,
    ...p,
  };
}

function snap(p: Partial<FactoryStatus> = {}): FactoryStatus {
  return { generatedAt: 0, activeAgents: 0, planeRepoCount: 1, loops: [], overall: 'idle', ...p };
}

describe('STATUS_META', () => {
  test('moving breathes AND pings; idle only breathes; not-armed/off are static', () => {
    expect(STATUS_META.moving.breathe && STATUS_META.moving.ping).toBe(true);
    expect(STATUS_META.idle.breathe).toBe(true);
    expect(STATUS_META.idle.ping).toBe(false);
    expect(STATUS_META['not-armed'].breathe).toBe(false);
    expect(STATUS_META.off.breathe).toBe(false);
    expect(STATUS_META.off.ping).toBe(false);
  });

  test('idle-but-alive still breathes — the user can SEE it is awake with nothing to do', () => {
    expect(STATUS_META.idle.breathe).toBe(true);
  });

  test('every status has a label + dot color', () => {
    for (const s of ['moving', 'idle', 'not-armed', 'off'] as FactoryLoopStatus[]) {
      expect(STATUS_META[s].label.length).toBeGreaterThan(0);
      expect(STATUS_META[s].dot).toContain('bg-');
    }
  });
});

describe('overallHeadline — honest per state', () => {
  test('moving with agents names the count', () => {
    expect(overallHeadline(snap({ overall: 'moving', activeAgents: 3 }))).toContain('3 agents');
  });

  test('moving with no agents but producing loops still reads moving', () => {
    expect(overallHeadline(snap({ overall: 'moving', activeAgents: 0 }))).toContain('moving');
  });

  test('not-armed headline says "not fueled" (the real current state)', () => {
    expect(overallHeadline(snap({ overall: 'not-armed' })).toLowerCase()).toContain('not fueled');
  });

  test('idle headline says alive and idle', () => {
    const h = overallHeadline(snap({ overall: 'idle' })).toLowerCase();
    expect(h).toContain('alive');
    expect(h).toContain('idle');
  });

  test('off headline says off', () => {
    expect(overallHeadline(snap({ overall: 'off' })).toLowerCase()).toContain('off');
  });
});

describe('loopReasonLine', () => {
  test('not-armed shows the actionable reason', () => {
    expect(loopReasonLine(loop('not-armed', { notArmedReason: 'no Plane backlog configured' }))).toContain('backlog');
  });

  test('idle surfaces the skip reason', () => {
    expect(loopReasonLine(loop('idle', { lastSkipReason: 'all issues claimed' }))).toBe('all issues claimed');
  });

  test('idle with no skip reason falls back to a sane default', () => {
    expect(loopReasonLine(loop('idle'))).toBe('nothing to do this tick');
  });

  test('moving needs no excuse', () => {
    expect(loopReasonLine(loop('moving'))).toBeUndefined();
  });

  test('off (flag disabled) reads "flag off"', () => {
    expect(loopReasonLine(loop('off', { flagEnabled: false }))).toBe('flag off');
  });
});

describe('fmtSince', () => {
  test('undefined → dash (never ticked)', () => {
    expect(fmtSince(undefined)).toBe('—');
  });
  test('seconds under 90 show as seconds', () => {
    expect(fmtSince(30)).toBe('30s ago');
  });
  test('minutes', () => {
    expect(fmtSince(120)).toBe('2m ago');
  });
  test('hours', () => {
    expect(fmtSince(7200)).toBe('2h ago');
  });
});
