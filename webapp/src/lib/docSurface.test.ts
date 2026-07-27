import { describe, expect, it } from 'bun:test';
import { byHeading, commentsHeadline, readinessLine, whatHappenedToIt, wroteState, type DocComment } from './docSurface';

const T = new Date('2026-07-26T15:45:31').getTime();
const comment = (over: Partial<DocComment> = {}): DocComment => ({ id: 'c', body: 'b', author: 'mara', createdAt: T, ...over });

describe('wroteState', () => {
  it('has four states, not one resolved bit', () => {
    expect(wroteState(comment())).toBe('written');
    expect(wroteState(comment({ sentAt: T }))).toBe('sent');
    expect(wroteState(comment({ sentAt: T, acknowledgedAt: T }))).toBe('acknowledged');
    expect(wroteState(comment({ sentAt: T, resolvedAt: T }))).toBe('resolved');
  });
});

describe('whatHappenedToIt', () => {
  it('says outright when nobody has seen it', () => {
    // A comment sitting unsent looks identical to one being worked on unless the surface says so.
    const line = whatHappenedToIt(comment());
    expect(line).toContain('never sent');
    expect(line).toContain('note to yourself');
  });

  it('distinguishes sent-and-silent from read back', () => {
    expect(whatHappenedToIt(comment({ sentAt: T }))).toContain('nobody has said anything back yet');
    expect(whatHappenedToIt(comment({ sentAt: T, acknowledgedAt: T }))).toContain('read back');
  });
});

describe('commentsHeadline', () => {
  it('leads with unsent, the state where the reader is the blocker', () => {
    const line = commentsHeadline([comment({ id: 'a' }), comment({ id: 'b', sentAt: T })]);
    expect(line.startsWith('1 thing you wrote')).toBe(true);
  });

  it('does not lead with progress once everything has reached someone', () => {
    expect(commentsHeadline([comment({ sentAt: T })])).toContain('all of them have reached somebody');
  });

  it('refuses to read an empty comment list as agreement', () => {
    expect(commentsHeadline([])).toContain('no way to tell those apart');
  });
});

describe('readinessLine', () => {
  it('refuses to call an advisory reading a gate', () => {
    // Saying a thing is a gate when nothing enforces it is worse than having no gate.
    expect(readinessLine([comment()])).toContain('this is a reading, not a lock');
    expect(readinessLine([comment({ resolvedAt: T })])).toContain('nothing here ever did');
  });

  it('says silence is not agreement', () => {
    expect(readinessLine([])).toContain('That is not agreement');
  });
});

describe('byHeading', () => {
  it('keeps unanchored comments visible and last', () => {
    const groups = byHeading([comment({ id: 'loose' }), comment({ id: 'anchored', heading: 'Scope' })]);
    expect(groups[0]!.heading).toBe('Scope');
    expect(groups[1]!.heading).toContain('not anchored');
  });
});
