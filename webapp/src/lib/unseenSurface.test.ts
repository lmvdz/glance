import { describe, expect, it } from 'bun:test';
import { ranked, tailNote, unseenHeadline, whyUnseen, type UnseenEntry, type UnseenInput } from './unseenSurface';

const T = new Date('2026-07-26T12:00:00Z').getTime();
const entry = (over: Partial<UnseenEntry> = {}): UnseenEntry => ({
  repo: '/r', file: 'src/a.ts', changesSinceSeen: 1, lastChangedAt: T - 3_600_000, debt: 1, state: 'stale', ...over,
});
const input = (over: Partial<UnseenInput> = {}): UnseenInput => ({ entries: [entry()], repoHasHistory: { '/r': true }, ...over });

describe('unseenHeadline', () => {
  it('says the substrate being off is not zero debt', () => {
    const line = unseenHeadline(input({ disabled: true, entries: [] }));
    expect(line).toContain('absence of measurement, not an absence of debt');
  });

  it('distinguishes no history from nothing missed', () => {
    expect(unseenHeadline(input({ entries: [], repoHasHistory: { '/r': false } }))).toContain('nothing yet to miss');
    expect(unseenHeadline(input({ entries: [] }))).toContain('you have read since it was touched');
  });

  it('counts never-opened separately from read-then-changed', () => {
    const line = unseenHeadline(input({
      entries: [entry({ file: 'a', state: 'stale' }), entry({ file: 'b', state: 'never-seen' }), entry({ file: 'c', state: 'never-seen' })],
    }));
    expect(line).toContain('1 you read before it changed');
    expect(line).toContain('2 you have never opened');
  });
});

describe('ranked', () => {
  it('ranks by debt, not by name', () => {
    const out = ranked([entry({ file: 'a', debt: 1 }), entry({ file: 'z', debt: 9 }), entry({ file: 'm', debt: 5 })]);
    expect(out.map((e) => e.file)).toEqual(['z', 'm', 'a']);
  });

  it('caps the list', () => {
    expect(ranked(Array.from({ length: 40 }, (_, i) => entry({ file: `f${i}`, debt: i })), 5)).toHaveLength(5);
  });
});

describe('whyUnseen', () => {
  it('explains a never-opened file without pretending you read it', () => {
    expect(whyUnseen(entry({ state: 'never-seen', changesSinceSeen: 3 }), T)).toContain('never opened');
  });

  it('says how many times a file moved since you read it', () => {
    const line = whyUnseen(entry({ state: 'stale', changesSinceSeen: 11, lastSeenAt: T - 86_400_000 * 3 }), T);
    expect(line).toContain('changed 11 times since');
    expect(line).toContain('3 days ago');
  });

  it('does not invent a read time it does not have', () => {
    expect(whyUnseen(entry({ state: 'stale', lastSeenAt: undefined }), T)).toContain('at some point');
  });
});

describe('tailNote', () => {
  it('says what was dropped rather than truncating silently', () => {
    expect(tailNote(40, 12)).toContain('28 more');
  });
  it('is silent when nothing was dropped', () => {
    expect(tailNote(5, 12)).toBeUndefined();
  });
});
