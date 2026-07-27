import { describe, expect, it } from 'bun:test';
import { EVIDENCE_FLOOR, claimBasis, evidenceWeight, sampleCaveat, sampleLine, whatWouldMakeThisWorthReading, type AgentRecordView, type RecordClaim } from './agentRecord';

const claim = (over: Partial<RecordClaim> = {}): RecordClaim => ({
  id: 'c1', claim: 'catches races', verification: 'checked', sampleSize: 6, date: 0, state: 'current', sourceNodeIds: ['n1'], ...over,
});
const record = (over: Partial<AgentRecordView> = {}): AgentRecordView => ({
  agentId: 'orin', provisional: false, profileMissing: false, claims: [claim()], ...over,
});

describe('sampleCaveat', () => {
  it('refuses to say anything about a thin record, by name', () => {
    const line = sampleCaveat(record(), 'Orin');
    expect(line).toContain('not enough to tell you anything about Orin');
    expect(line).toContain('what the role does by default');
  });

  it('says nothing is recorded rather than showing an empty list as a verdict', () => {
    expect(sampleCaveat(record({ claims: [] }), 'Orin')).toContain('Nothing has been recorded');
  });

  it('steps out of the way once the evidence carries itself', () => {
    expect(sampleCaveat(record({ claims: [claim({ sampleSize: EVIDENCE_FLOOR })] }), 'Pike')).toBeUndefined();
  });
});

describe('sampleLine', () => {
  it('marks a small sample as unable to carry a rate', () => {
    expect(sampleLine(record())).toBe('6 units · too few for any rate');
  });

  it('does not say "0 units" as though that were a measurement', () => {
    expect(sampleLine(record({ claims: [] }))).toBe('no units recorded');
  });
});

describe('evidenceWeight', () => {
  it('takes the largest sample behind any claim, not the sum', () => {
    expect(evidenceWeight(record({ claims: [claim({ sampleSize: 4 }), claim({ id: 'c2', sampleSize: 9 })] }))).toBe(9);
  });
});

describe('claimBasis', () => {
  const date = () => '4 July';
  it('keeps a withdrawn claim and says why it stays', () => {
    expect(claimBasis(claim({ state: 'withdrawn' }), date)).toContain('true to its evidence then');
  });
  it('distinguishes the agent’s own word from a check', () => {
    expect(claimBasis(claim({ verification: 'agent-word' }), date)).toContain('own word, not checked');
    expect(claimBasis(claim(), date)).toContain('checked against the units');
  });
});

describe('whatWouldMakeThisWorthReading', () => {
  it('says how much more evidence would end the not-knowing', () => {
    expect(whatWouldMakeThisWorthReading(record()).some((line) => line.includes(`${EVIDENCE_FLOOR - 6} more`))).toBe(true);
  });

  it('asks for a checked claim only when none is checked', () => {
    expect(whatWouldMakeThisWorthReading(record()).some((line) => line.includes('own account'))).toBe(false);
    expect(whatWouldMakeThisWorthReading(record({ claims: [claim({ verification: 'agent-word' })] })).some((line) => line.includes('own account'))).toBe(true);
  });

  it('always names the untested expensive case', () => {
    expect(whatWouldMakeThisWorthReading(record({ claims: [claim({ sampleSize: 40 })] })).some((line) => line.includes('expensive'))).toBe(true);
  });
});
