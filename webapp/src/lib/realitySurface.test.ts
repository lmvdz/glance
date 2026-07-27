import { describe, expect, it } from 'bun:test';
import { claimMark, driftLines, evidenceLine, realityHeadline, type RealityRollup } from './realitySurface';

const rollup = (over: Partial<RealityRollup> = {}): RealityRollup => ({
  totalConcerns: 21, done: 14, open: 7, blocked: 0, doneProven: 14, doneStale: 0, doneUnproven: 0,
  proofPresent: true, proofReachable: true, ...over,
});

describe('realityHeadline', () => {
  it('leads with the gap, not with the reassuring half of the same fact', () => {
    const line = realityHeadline(rollup({ doneProven: 9, doneUnproven: 4, doneStale: 1 }));
    expect(line.startsWith('5 of the 14')).toBe(true);
    expect(line).toContain('4 with no evidence at all');
    expect(line).toContain('older main');
  });

  it('says so plainly when every claim is backed', () => {
    expect(realityHeadline(rollup())).toContain('every one of them has evidence behind it');
  });

  it('distinguishes no claims from unbacked claims', () => {
    // A plan where nothing is done has no gap. Reporting "0 unproven" would read as a clean bill.
    expect(realityHeadline(rollup({ done: 0, open: 21, doneProven: 0 }))).toContain('there are no claims');
  });

  it('does not describe an empty plan as fully proven', () => {
    expect(realityHeadline(rollup({ totalConcerns: 0, done: 0, open: 0, doneProven: 0 }))).toContain('nothing to check');
  });
});

describe('evidenceLine', () => {
  it('treats unknown reachability as neither yes nor no', () => {
    const line = evidenceLine(rollup({ proofReachable: null }));
    expect(line).toContain('could not be determined');
    expect(line).toContain('not the same as gone');
    expect(line).toContain('not the same as fine');
  });

  it('says a dead proof is about a repository that no longer exists', () => {
    expect(evidenceLine(rollup({ proofReachable: false }))).toContain('no longer exists');
  });

  it('says every done is somebody’s word when there is no proof at all', () => {
    expect(evidenceLine(rollup({ proofPresent: false }))).toContain('somebody’s word');
  });
});

describe('claimMark', () => {
  it('never folds stale into proven', () => {
    expect(claimMark('done-stale').label).toBe('stale');
    expect(claimMark('done-stale').why).toContain('different repository');
    expect(claimMark('done-proven').label).toBe('proven');
    expect(claimMark('done-stale').tone).not.toBe(claimMark('done-proven').tone);
  });

  it('marks an unproven claim as the alarm it is', () => {
    expect(claimMark('done-unproven').tone).toBe('#B4553A');
  });
});

describe('driftLines', () => {
  it('leads with what nobody reviewing the plan knew about', () => {
    const lines = driftLines({ plannedNotTouched: ['a.ts'], touchedNotPlanned: ['b.ts', 'c.ts'], actualChangedFiles: 5 });
    expect(lines[0]).toContain('never mentioned');
    expect(lines[1]).toContain('promised more than it delivered');
  });

  it('refuses to call it a comparison when the actual changes could not be read', () => {
    const lines = driftLines({ plannedNotTouched: ['a.ts'], touchedNotPlanned: [], actualChangedFiles: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('nothing below is a comparison');
  });

  it('says plainly when there is no drift', () => {
    expect(driftLines({ plannedNotTouched: [], touchedNotPlanned: [], actualChangedFiles: 3 })[0]).toContain('what it said it would change');
  });
});
