import { describe, expect, it } from 'bun:test';
import type { TaskDecision } from '../types';
import {
  splitDecisions,
  isSuperseded,
  shouldCollapseSuperseded,
  SUPERSEDED_INLINE_MAX,
  decisionSourceLabel,
  decisionAge,
  decisionsEmptyState,
  criteriaEmptyState,
  criteriaHeadline,
} from './decisionSurface';

function decision(over: Partial<TaskDecision>): TaskDecision {
  return { id: 'd1', text: 'text', ...over };
}

describe('splitDecisions', () => {
  it('puts decisions with no supersededBy in current, the rest in superseded', () => {
    const decisions = [
      decision({ id: 'a', supersededBy: undefined }),
      decision({ id: 'b', supersededBy: 'c' }),
      decision({ id: 'c' }),
    ];
    const { current, superseded } = splitDecisions(decisions);
    expect(current.map((d) => d.id).sort()).toEqual(['a', 'c']);
    expect(superseded.map((d) => d.id)).toEqual(['b']);
  });

  it('sorts each group newest first by createdAt', () => {
    const decisions = [
      decision({ id: 'old', createdAt: 1 }),
      decision({ id: 'new', createdAt: 3 }),
      decision({ id: 'mid', createdAt: 2 }),
    ];
    expect(splitDecisions(decisions).current.map((d) => d.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sinks decisions with no createdAt to the end rather than guessing them as newest', () => {
    const decisions = [
      decision({ id: 'no-date' }),
      decision({ id: 'dated', createdAt: 100 }),
    ];
    expect(splitDecisions(decisions).current.map((d) => d.id)).toEqual(['dated', 'no-date']);
  });

  it('returns empty groups for an empty ledger', () => {
    expect(splitDecisions([])).toEqual({ current: [], superseded: [] });
  });

  // Invariant I2: the split is a partition, never a filter that can lose or duplicate a decision.
  it('partitions every seeded decision exactly once across current+superseded — nothing dropped, nothing duplicated (I2)', () => {
    const decisions = [
      decision({ id: 'a' }),
      decision({ id: 'b', supersededBy: 'z' }),
      decision({ id: 'c', createdAt: 5 }),
      decision({ id: 'd', supersededBy: 'a', createdAt: 1 }),
      decision({ id: 'e', supersededBy: '' }),
    ];
    const { current, superseded } = splitDecisions(decisions);
    const seenIds = [...current, ...superseded].map((d) => d.id).sort();
    expect(seenIds).toEqual(decisions.map((d) => d.id).sort());
    expect(new Set(seenIds).size).toBe(decisions.length);
  });

  // Junk-graph safety: splitDecisions never resolves supersededBy against other decisions' ids, so a
  // dangling or self-referential pointer can neither throw nor make the decision vanish.
  it('does not throw and does not drop a decision whose supersededBy names an id that does not exist on the feature', () => {
    const decisions = [decision({ id: 'orphan', supersededBy: 'ghost-id-not-on-this-feature', createdAt: 1 })];
    expect(() => splitDecisions(decisions)).not.toThrow();
    const { current, superseded } = splitDecisions(decisions);
    expect(current).toHaveLength(0);
    expect(superseded.map((d) => d.id)).toEqual(['orphan']);
  });

  it('does not throw and does not drop a decision with a self-referential supersededBy', () => {
    const decisions = [decision({ id: 'self-ref', supersededBy: 'self-ref', createdAt: 1 })];
    expect(() => splitDecisions(decisions)).not.toThrow();
    const { current, superseded } = splitDecisions(decisions);
    expect(current).toHaveLength(0);
    expect(superseded.map((d) => d.id)).toEqual(['self-ref']);
  });
});

describe('isSuperseded', () => {
  it('treats undefined and empty-string supersededBy as NOT superseded', () => {
    expect(isSuperseded({ supersededBy: undefined })).toBe(false);
    expect(isSuperseded({ supersededBy: '' })).toBe(false);
  });

  it('treats any non-empty supersededBy as superseded, including a dangling or self-referential id', () => {
    expect(isSuperseded({ supersededBy: 'some-id' })).toBe(true);
    expect(isSuperseded({ supersededBy: 'ghost-id-not-on-this-feature' })).toBe(true);
  });
});

describe('shouldCollapseSuperseded', () => {
  it('does not collapse a small history', () => {
    expect(SUPERSEDED_INLINE_MAX).toBe(2);
    expect(shouldCollapseSuperseded(0)).toBe(false);
    expect(shouldCollapseSuperseded(2)).toBe(false);
  });

  it('collapses once history grows past the inline max', () => {
    expect(shouldCollapseSuperseded(3)).toBe(true);
    expect(shouldCollapseSuperseded(10)).toBe(true);
  });
});

describe('decisionSourceLabel', () => {
  it('labels each known source', () => {
    expect(decisionSourceLabel('plan')).toBe('plan');
    expect(decisionSourceLabel('human')).toBe('human');
    expect(decisionSourceLabel('agent')).toBe('agent');
    expect(decisionSourceLabel('model-delta')).toBe('model delta');
  });

  it('reads an absent source as "recorded", never a fabricated one', () => {
    expect(decisionSourceLabel(undefined)).toBe('recorded');
  });
});

describe('decisionAge', () => {
  const now = 1_700_000_000_000;

  it('returns undefined when there is no createdAt to read', () => {
    expect(decisionAge(undefined, now)).toBeUndefined();
  });

  it('reads sub-minute ages as "moments ago"', () => {
    expect(decisionAge(now - 5_000, now)).toBe('moments ago');
  });

  it('reads minutes, hours, and days at the right thresholds', () => {
    expect(decisionAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(decisionAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(decisionAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('decisionsEmptyState', () => {
  it('states a first visit, not a quiet stretch, matching the house voice', () => {
    const text = decisionsEmptyState();
    expect(text).toContain('first visit');
    expect(text).toContain('ever removed, only superseded');
  });
});

describe('criteriaEmptyState / criteriaHeadline', () => {
  it('names the empty case as an absence, not a bare 0-of-0', () => {
    expect(criteriaHeadline([])).toBe(criteriaEmptyState());
    expect(criteriaEmptyState()).toContain('absence');
  });

  it('rolls up partial completion plainly', () => {
    expect(criteriaHeadline([{ completed: true }, { completed: false }, { completed: false }])).toBe('1 of 3 met.');
  });

  it('says "all" once everything is complete', () => {
    expect(criteriaHeadline([{ completed: true }, { completed: true }])).toBe('All 2 met.');
  });

  it('reads zero-of-N through the same "N of M met" shape, not a special case', () => {
    expect(criteriaHeadline([{ completed: false }, { completed: false }])).toBe('0 of 2 met.');
  });
});
