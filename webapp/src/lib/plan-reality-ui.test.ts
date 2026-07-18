/**
 * plan-reality-ui.test.ts — pure badge/tone derivation for PlanRealityView.tsx (OMPSQ-448).
 * DOM-free (bun:test).
 */

import { expect, test, describe } from 'bun:test';
import {
  realityStateBadge,
  blockedBadge,
  verifiedBadge,
  reachabilityBadge,
  proofRingTone,
  scopeDriftLabel,
} from './plan-reality-ui';
import type { PlanRealityRollupDTO } from './dto';

describe('realityStateBadge', () => {
  test('done-proven reads as a solid green "proven" badge', () => {
    expect(realityStateBadge('done-proven').label).toBe('✓ proven');
    expect(realityStateBadge('done-proven').className).toContain('emerald');
  });

  test('done-stale and done-unproven are distinct tones — different failure shapes', () => {
    const stale = realityStateBadge('done-stale');
    const unproven = realityStateBadge('done-unproven');
    expect(stale.label).toBe('⚠ stale proof');
    expect(stale.className).toContain('amber');
    expect(unproven.label).toBe('● unproven');
    expect(unproven.className).toContain('orange');
    expect(stale.className).not.toBe(unproven.className);
  });

  test('open is the neutral fallback', () => {
    expect(realityStateBadge('open').label).toBe('○ open');
    expect(realityStateBadge('open').className).toContain('gray');
  });
});

test('blockedBadge is a distinct danger-toned chip', () => {
  expect(blockedBadge().label).toBe('blocked');
  expect(blockedBadge().className).toContain('red');
});

describe('verifiedBadge', () => {
  test('green ⇒ success tone', () => {
    expect(verifiedBadge('green').className).toContain('emerald');
  });
  test('red-baseline ⇒ danger tone', () => {
    expect(verifiedBadge('red-baseline').className).toContain('red');
  });
  test('unverified / absent ⇒ neutral tone', () => {
    expect(verifiedBadge('unverified').className).toContain('gray');
    expect(verifiedBadge(undefined).className).toContain('gray');
  });
});

describe('reachabilityBadge', () => {
  test('true ⇒ "on <default>"', () => {
    expect(reachabilityBadge(true, 'main').label).toBe('on main');
    expect(reachabilityBadge(true).label).toBe('on default');
  });
  test('false ⇒ STALE', () => {
    expect(reachabilityBadge(false).label).toBe('STALE');
    expect(reachabilityBadge(false).className).toContain('red');
  });
  test('null ⇒ unknown', () => {
    expect(reachabilityBadge(null).label).toBe('unknown');
  });
});

describe('proofRingTone', () => {
  test('green only when every done concern is proven', () => {
    expect(proofRingTone({ done: 3, doneProven: 3 })).toBe('green');
  });
  test('amber when any done concern is stale/unproven', () => {
    expect(proofRingTone({ done: 3, doneProven: 2 })).toBe('amber');
  });
  test('amber (not green) when nothing is done yet — nothing proven either', () => {
    expect(proofRingTone({ done: 0, doneProven: 0 })).toBe('amber');
  });
});

function scopeDrift(overrides: Partial<PlanRealityRollupDTO['scopeDrift']> = {}): PlanRealityRollupDTO['scopeDrift'] {
  return { plannedTouches: 0, actualChangedFiles: 0, plannedNotTouched: [], touchedNotPlanned: [], ...overrides };
}

describe('scopeDriftLabel', () => {
  test('actualChangedFiles === null ⇒ "diff n/a", never a false 0/0', () => {
    expect(scopeDriftLabel(scopeDrift({ actualChangedFiles: null }))).toBe('diff n/a');
  });

  test('counts plannedNotTouched and touchedNotPlanned', () => {
    expect(
      scopeDriftLabel(scopeDrift({ actualChangedFiles: 5, plannedNotTouched: ['a.ts'], touchedNotPlanned: ['b.ts', 'c.ts'] })),
    ).toBe('1 declared not touched · 2 touched not declared');
  });

  test('zero drift on both sides', () => {
    expect(scopeDriftLabel(scopeDrift({ actualChangedFiles: 5 }))).toBe('0 declared not touched · 0 touched not declared');
  });
});
