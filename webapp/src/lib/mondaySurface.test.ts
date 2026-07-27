import { describe, expect, it } from 'bun:test';
import { direction, frictionGroups, frictionHeadline, frictionWeight, nothingRecorded, type CounterSeries, type FrictionEntry } from './mondaySurface';

const series = (over: Partial<CounterSeries> = {}): CounterSeries => ({ key: 'prompts', label: 'prompts', today: 1, week: 10, spark: [3, 3, 2, 1, 1, 0, 0], ...over });
const gripe = (over: Partial<FrictionEntry> = {}): FrictionEntry => ({ id: 'g', ts: 1, repo: '/r', gripe: 'the land gate is too slow to matter', ...over });

describe('direction', () => {
  it('says which way in real units, never a percentage', () => {
    // 1 → 3 is "up 200%", which is true and useless.
    const line = direction(series({ spark: [3, 3, 2, 1, 1, 0], week: 10 }));
    expect(line).toContain('fewer in the last few days');
    expect(line).not.toContain('%');
  });

  it('refuses to call a direction on too few days', () => {
    expect(direction(series({ spark: [1, 2] }))).toContain('Not enough days recorded');
  });

  it('does not report movement when there was none', () => {
    expect(direction(series({ spark: [0, 0, 0, 0, 0, 0], week: 0 }))).toContain('Nothing recorded either half');
  });
});

describe('nothingRecorded', () => {
  it('is a first-class state, not a row of zeros', () => {
    expect(nothingRecorded([series({ week: 0 }), series({ key: 'b', week: 0 })])).toBe(true);
    expect(nothingRecorded([series({ week: 0 }), series({ key: 'b', week: 2 })])).toBe(false);
  });
});

describe('frictionGroups', () => {
  it('groups by what it is and ranks by how often, not by when', () => {
    const groups = frictionGroups([
      gripe({ id: '1', ts: 1 }), gripe({ id: '2', ts: 2 }), gripe({ id: '3', ts: 9, gripe: 'a one-off thing nobody repeated ever' }),
    ]);
    expect(groups[0]!.count).toBe(2);
    expect(groups[1]!.count).toBe(1);
  });
});

describe('frictionWeight', () => {
  it('keeps a person’s complaint apart from the daemon’s', () => {
    expect(frictionWeight({ count: 4, humans: 0 })).toContain('Weaker evidence than a person complaining once');
    expect(frictionWeight({ count: 2, humans: 2 })).toContain('written down by a person');
    expect(frictionWeight({ count: 5, humans: 2 })).toContain('The 2 count for more');
  });
});

describe('frictionHeadline', () => {
  it('says an empty ledger proves nothing either way', () => {
    expect(frictionHeadline([])).toContain('proves neither');
  });
  it('leads with repeats when there are any', () => {
    expect(frictionHeadline([gripe({ id: '1' }), gripe({ id: '2' })])).toContain('worth more than a thing that happened');
  });
  it('says plainly when nothing is a pattern yet', () => {
    expect(frictionHeadline([gripe({ id: '1' })])).toContain('Nothing here is a pattern yet');
  });
});
