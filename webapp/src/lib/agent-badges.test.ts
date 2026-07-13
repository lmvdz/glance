/**
 * agent-badges.test.ts — the shared trust-legibility helpers every land surface derives from, so a
 * validator VETO and run confidence read the same everywhere (no cross-surface drift). DOM-free.
 */

import { expect, test, describe } from 'bun:test';
import { isVetoed, isValidatorHeld, validationBadge, confidenceBadge } from './agent-badges';
import type { AgentDTO, ValidationRecordDTO } from './dto';

const val = (verdict: ValidationRecordDTO['verdict'], rationale = 'because'): ValidationRecordDTO => ({
  verdict,
  agreement: 0,
  confidence: 0.9,
  perCriterion: [],
  rationale,
});

describe('isVetoed', () => {
  test('true only for a veto verdict', () => {
    expect(isVetoed({ validation: val('veto') } as AgentDTO)).toBe(true);
    expect(isVetoed({ validation: val('pass') } as AgentDTO)).toBe(false);
    expect(isVetoed({ validation: val('abstain') } as AgentDTO)).toBe(false);
    expect(isVetoed({ validation: val('skipped') } as AgentDTO)).toBe(false);
    expect(isVetoed({} as AgentDTO)).toBe(false);
  });
});

describe('isValidatorHeld', () => {
  // Fail-open fix: a bare `verdict !== 'veto'` check across several land surfaces used to read an
  // "inconclusive" verdict (the diff couldn't be COMPUTED, an environmental git fault) as safe to land.
  // This helper is the single source of truth every one of those surfaces now derives from.
  test('true for veto and inconclusive; false for pass/abstain/skipped/absent', () => {
    expect(isValidatorHeld({ validation: val('veto') } as AgentDTO)).toBe(true);
    expect(isValidatorHeld({ validation: val('inconclusive') } as AgentDTO)).toBe(true);
    expect(isValidatorHeld({ validation: val('pass') } as AgentDTO)).toBe(false);
    expect(isValidatorHeld({ validation: val('abstain') } as AgentDTO)).toBe(false);
    expect(isValidatorHeld({ validation: val('skipped') } as AgentDTO)).toBe(false);
    expect(isValidatorHeld({} as AgentDTO)).toBe(false);
  });
});

describe('validationBadge', () => {
  test('veto → red "vetoed" pill carrying the rationale', () => {
    const b = validationBadge({ validation: val('veto', 'criterion 2 unmet') } as AgentDTO);
    expect(b?.label).toBe('vetoed');
    expect(b?.title).toBe('criterion 2 unmet');
    expect(b?.cls).toContain('red');
  });
  test('pass → green "validated"', () => {
    expect(validationBadge({ validation: val('pass') } as AgentDTO)?.label).toBe('validated');
  });
  test('abstain → muted "unjudged"; skipped and absent → no pill', () => {
    expect(validationBadge({ validation: val('abstain') } as AgentDTO)?.label).toBe('unjudged');
    expect(validationBadge({ validation: val('skipped') } as AgentDTO)).toBeNull();
    expect(validationBadge({} as AgentDTO)).toBeNull();
  });
});

describe('confidenceBadge', () => {
  test('absent → null (no run yet)', () => {
    expect(confidenceBadge({} as AgentDTO)).toBeNull();
  });
  test('below the 0.4 floor → amber + propose-only note', () => {
    const b = confidenceBadge({ confidence: 0.22 } as AgentDTO);
    expect(b?.label).toBe('conf 22% · propose-only');
    expect(b?.cls).toContain('amber');
  });
  test('at/above floor → plain percent, no cap note', () => {
    const b = confidenceBadge({ confidence: 0.8 } as AgentDTO);
    expect(b?.label).toBe('conf 80%');
    expect(b?.label).not.toContain('propose-only');
  });
});
