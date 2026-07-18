/**
 * plan-reality-route.test.ts — the `#/plan-reality[/:featureId]` hash route + the plans-index
 * filter (OMPSQ-448). DOM-free (bun:test), mirrors plan-doc-review's own hash tests.
 */

import { expect, test, describe } from 'bun:test';
import { parsePlanRealityHash, buildPlanRealityHash, planFeatures } from './plan-reality-route';
import type { FeatureDTO } from './dto';

describe('parsePlanRealityHash', () => {
  test('bare "#/plan-reality" parses to the index (no featureId)', () => {
    expect(parsePlanRealityHash('#/plan-reality')).toEqual({ featureId: undefined });
  });

  test('"#/plan-reality/<id>" parses to that feature', () => {
    expect(parsePlanRealityHash('#/plan-reality/plan:glance:plans/foo')).toEqual({
      featureId: 'plan:glance:plans/foo',
    });
  });

  test('decodes a URL-encoded featureId', () => {
    const encoded = `#/plan-reality/${encodeURIComponent('plan:glance:plans/foo bar')}`;
    expect(parsePlanRealityHash(encoded)).toEqual({ featureId: 'plan:glance:plans/foo bar' });
  });

  test('an unrelated hash is not a plan-reality deep link', () => {
    expect(parsePlanRealityHash('#/review/abc')).toBeUndefined();
    expect(parsePlanRealityHash('')).toBeUndefined();
    expect(parsePlanRealityHash('#/plan-realityXYZ')).toBeUndefined();
  });
});

describe('buildPlanRealityHash', () => {
  test('no featureId ⇒ the bare index hash', () => {
    expect(buildPlanRealityHash({})).toBe('#/plan-reality');
  });

  test('a featureId ⇒ the per-plan hash, URL-encoded', () => {
    expect(buildPlanRealityHash({ featureId: 'plan:glance:plans/foo' })).toBe(
      '#/plan-reality/plan%3Aglance%3Aplans%2Ffoo',
    );
  });

  test('round-trips through parse', () => {
    const loc = { featureId: 'plan:glance:plans/foo bar' };
    expect(parsePlanRealityHash(buildPlanRealityHash(loc))).toEqual(loc);
  });
});

function feature(overrides: Partial<FeatureDTO> = {}): FeatureDTO {
  return {
    id: 'f1',
    title: 'Feature',
    repo: 'glance',
    stage: 'in-progress',
    agentIds: [],
    assignees: [],
    worktrees: [],
    unlandedFiles: 0,
    divergent: false,
    blocked: false,
    statusCounts: {},
    readiness: { ready: false, state: 'no-candidate', blockers: [], nextAction: '' },
    ...overrides,
  };
}

describe('planFeatures', () => {
  test('keeps only features with a planDir', () => {
    const withPlan = feature({ id: 'a', planDir: 'plans/foo' });
    const withoutPlan = feature({ id: 'b' });
    expect(planFeatures([withPlan, withoutPlan])).toEqual([withPlan]);
  });

  test('empty input ⇒ empty output', () => {
    expect(planFeatures([])).toEqual([]);
  });

  test('an empty-string planDir is falsy — filtered out like absent', () => {
    const blank = feature({ id: 'c', planDir: '' });
    expect(planFeatures([blank])).toEqual([]);
  });
});
