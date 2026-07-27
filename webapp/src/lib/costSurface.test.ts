import { describe, expect, it } from 'bun:test';
import { floorCaveat, headline, spendBought, totals, wasteCause, wasteLines, whatThisCannotSee, worthItSentence, type CostReceipt } from './costSurface';

const run = (over: Partial<CostReceipt> = {}): CostReceipt => ({ agentId: 'a1', name: 'wren', status: 'idle', costUsd: 1, startedAt: 1, ...over });

describe('wasteCause', () => {
  it('names a crash and a rejection, and nothing else', () => {
    expect(wasteCause(run({ status: 'error' }))).toContain('error');
    expect(wasteCause(run({ validation: { verdict: 'veto' } }))).toContain('vetoed');
    expect(wasteCause(run({ validation: { verdict: 'fail' } }))).toContain('rejected');
    expect(wasteCause(run())).toBeUndefined();
  });

  it('does not call a run that touched no files waste', () => {
    // A review run legitimately changes nothing. Counting it would make the waste figure a guess, and
    // the heading promises every dollar of it has a cause.
    expect(wasteCause(run({ filesTouched: [], toolCalls: 40 }))).toBeUndefined();
  });
});

describe('totals', () => {
  it('counts spend and waste separately, not waste as a slice of a single number', () => {
    const t = totals([run({ costUsd: 10 }), run({ agentId: 'a2', costUsd: 4, status: 'error' })]);
    expect(t.spendUsd).toBe(14);
    expect(t.wasteUsd).toBe(4);
    expect(t.units).toBe(2);
  });

  it('treats an unpriced run as unpriced, never as zero', () => {
    const t = totals([run({ costUsd: 10 }), run({ agentId: 'a2', costUsd: undefined })]);
    expect(t.spendUsd).toBe(10);
    expect(t.unpricedRuns).toBe(1);
    expect(t.runs).toBe(2);
  });
});

describe('headline', () => {
  it('says nothing has been measured rather than reporting zero', () => {
    expect(headline(totals([]))).toContain('nothing to measure');
  });

  it('marks the spend as a floor when any run is unpriced', () => {
    const line = headline(totals([run({ costUsd: 10 }), run({ agentId: 'a2', costUsd: undefined })]));
    expect(line).toContain('at least');
  });

  it('does not claim there was no waste — only that none is visible', () => {
    const line = headline(totals([run({ costUsd: 10 })]));
    expect(line).toContain('that we can see');
  });
});

describe('floorCaveat', () => {
  it('is silent when every run carries a price', () => {
    expect(floorCaveat(totals([run()]))).toBeUndefined();
  });

  it('says the page cannot show cost at all when nothing is priced', () => {
    const caveat = floorCaveat(totals([run({ costUsd: undefined })]));
    expect(caveat).toContain('what it cost');
  });

  it('calls a partial total a floor', () => {
    const caveat = floorCaveat(totals([run(), run({ agentId: 'a2', costUsd: undefined })]));
    expect(caveat).toContain('floor');
    expect(caveat).toContain('not a free run');
  });
});

describe('spendBought', () => {
  it('groups by unit and keeps wasted units out of what the spend bought', () => {
    const lines = spendBought([
      run({ agentId: 'a1', name: 'wren', costUsd: 5, filesTouched: ['a.ts'] }),
      run({ agentId: 'a1', name: 'wren', costUsd: 3, filesTouched: ['b.ts'] }),
      run({ agentId: 'a2', name: 'pike', costUsd: 9, status: 'error' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('wren');
    expect(lines[0]!.costUsd).toBe(8);
    expect(lines[0]!.meta).toContain('2 files changed');
  });

  it('says a unit changed nothing on disk rather than showing an empty count', () => {
    expect(spendBought([run({ filesTouched: [] })])[0]!.meta).toContain('changed nothing on disk');
  });
});

describe('wasteLines', () => {
  it('carries a cause on every line', () => {
    const lines = wasteLines([run({ status: 'error', costUsd: 2 }), run({ agentId: 'a2', validation: { verdict: 'fail' }, costUsd: 7 })]);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !!line.cause)).toBe(true);
    expect(lines[0]!.costUsd).toBe(7);
  });
});

describe('worthItSentence', () => {
  it('refuses to price the reader’s time', () => {
    expect(worthItSentence(totals([run()]))).toContain('not going to put a number on your afternoon');
  });
});

describe('whatThisCannotSee', () => {
  it('names the unpriced exclusion only when there is one', () => {
    expect(whatThisCannotSee(totals([run()])).some((line) => line.includes('no price'))).toBe(false);
    expect(whatThisCannotSee(totals([run({ costUsd: undefined })])).some((line) => line.includes('no price'))).toBe(true);
  });
});
