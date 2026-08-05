import { describe, expect, it } from 'bun:test';
import { absences, confidenceLine, consideredNotSurfaced, notSurfacedSentence, restsOn, reviewerPrecisionLine, verdictSentence, type VerdictCriterion } from './gateVerdict';

describe('verdictSentence', () => {
  it('distinguishes a missing verdict from a verdict of unknown', () => {
    // The old chip rendered `verdict ?? 'unknown'`, which reads as a reviewer saying they were unsure.
    // Nobody having reviewed is a different fact and a more alarming one.
    const line = verdictSentence({});
    expect(line).toContain('No verdict was pinned');
    expect(line).toContain('not a verdict of');
  });

  it('leads with the reason on a veto and with the failures on a fail', () => {
    expect(verdictSentence({ verdict: 'veto', unitName: 'wren' })).toContain('vetoed');
    expect(verdictSentence({ verdict: 'fail', unitName: 'wren' })).toContain('failing checks are first');
  });

  it('frames a pass as a judgement you can disagree with', () => {
    expect(verdictSentence({ verdict: 'pass', unitName: 'wren' })).toContain('disagree with it in under a minute');
  });

  it('quotes a verdict word it does not recognise rather than dropping it', () => {
    expect(verdictSentence({ verdict: 'deferred' })).toContain('“deferred”');
  });
});

describe('confidenceLine', () => {
  it('states confidence in words rather than a comparable percentage', () => {
    expect(confidenceLine({ confidence: 0.95 })).toContain('was sure');
    expect(confidenceLine({ confidence: 0.4 })).toContain('not sure');
    expect(confidenceLine({ confidence: 0.95, agreement: 0.3 })).toContain('disagreed with each other');
  });

  it('says nothing when nothing was recorded', () => {
    expect(confidenceLine({})).toBeUndefined();
  });
});

describe('restsOn', () => {
  const criteria: VerdictCriterion[] = [
    { id: 'tests', satisfied: true, note: 'suite green on the merge base' },
    { id: 'quiet', satisfied: true },
    { id: 'lint', satisfied: false, note: 'two new warnings' },
  ];

  it('puts failures first — order is the argument', () => {
    expect(restsOn(criteria).map((c) => c.id)).toEqual(['lint', 'tests']);
  });

  it('keeps quiet passes out of the argument and names them separately', () => {
    expect(consideredNotSurfaced(criteria).map((c) => c.id)).toEqual(['quiet']);
  });
});

describe('notSurfacedSentence', () => {
  it('explains why the quiet list exists at all', () => {
    expect(notSurfacedSentence(3)).toContain('a check that never ran');
  });
  it('says plainly when nothing was left out', () => {
    expect(notSurfacedSentence(0)).toContain('Nothing was left out');
  });
});

describe('reviewerPrecisionLine', () => {
  it('renders an unmeasured lineage honestly, never a fabricated 0%', () => {
    const line = reviewerPrecisionLine({ lineage: 'grok', n: 0 });
    expect(line).toContain('unmeasured');
    expect(line).not.toContain('0%');
  });

  it('states a measured precision with its n', () => {
    const line = reviewerPrecisionLine({ lineage: 'codex', n: 52, survivedRate: 0.75, provisional: false });
    expect(line).toContain('75%');
    expect(line).toContain('52');
    expect(line).not.toContain('provisional');
  });

  it('names a provisional lineage as provisional', () => {
    const line = reviewerPrecisionLine({ lineage: 'native', n: 6, survivedRate: 1, provisional: true });
    expect(line).toContain('provisional');
    expect(line).toContain('6');
  });

  it('says nothing when no reviewer identity was resolved', () => {
    expect(reviewerPrecisionLine(undefined)).toBeUndefined();
  });

  // ── gauntlet round 1 ──────────────────────────────────────────────────────────────────────────

  it('renders a true rate under 1% as "<1%", never an indistinguishable "0%"', () => {
    const line = reviewerPrecisionLine({ lineage: 'grok', n: 201, survivedRate: 1 / 201, provisional: false });
    expect(line).toContain('<1%');
    expect(line).not.toContain('0%');
  });

  it('renders an unreadable ledger with its own reason, distinct from plain unmeasured', () => {
    const line = reviewerPrecisionLine({ lineage: 'grok', n: 0, unreadable: 'EACCES: permission denied' });
    expect(line).toContain('could not be read');
    expect(line).toContain('permission denied');
  });

  it('renders a too-corrupt-to-trust ledger with its own reason, citing the unparseable count', () => {
    const line = reviewerPrecisionLine({ lineage: 'grok', n: 0, corrupt: true, rejected: 9 });
    expect(line).toContain('too corrupt to trust');
    expect(line).toContain('9 unparseable rows');
  });

  it('never fabricates a 0% when n>0 but the rate is genuinely missing', () => {
    const line = reviewerPrecisionLine({ lineage: 'grok', n: 5, provisional: true });
    expect(line).toContain('unmeasured');
    expect(line).not.toContain('0%');
  });
});

describe('absences', () => {
  it('says a missing proof is a failure to find, not a proof of absence', () => {
    expect(absences({}).some((line) => line.includes('not that it does not exist'))).toBe(true);
  });

  it('counts ignored records as a risk rather than a footnote', () => {
    expect(absences({ malformedLandRecords: 2 }).some((line) => line.includes('Ignored is not the same as absent'))).toBe(true);
  });

  it('is silent about what is present', () => {
    expect(absences({ validation: {}, doneProof: {}, landAttempt: {} })).toEqual([]);
  });
});
