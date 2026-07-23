import { describe, expect, test } from 'bun:test';
import { buildPlanBriefHash, parsePlanBriefHash, planBriefFeatures, planBriefNameFromDir } from './plan-brief-route';
import type { FeatureDTO } from './dto';

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

describe('plan brief hash route', () => {
  test('round-trips encoded plan names', () => {
    const location = { name: 'land assessment' };
    expect(buildPlanBriefHash(location)).toBe('#/plans/land%20assessment/brief');
    expect(parsePlanBriefHash(buildPlanBriefHash(location))).toEqual(location);
  });

  test('rejects unrelated hashes', () => {
    expect(parsePlanBriefHash('#/plans/foo')).toBeUndefined();
    expect(parsePlanBriefHash('#/plan-reality/foo')).toBeUndefined();
  });
});

describe('planBriefFeatures', () => {
  test('keeps features with a real plans/<name> directory', () => {
    const withPlan = feature({ id: 'a', planDir: 'plans/foo' });
    const withoutPlan = feature({ id: 'b' });
    expect(planBriefFeatures([withPlan, withoutPlan])).toEqual([withPlan]);
  });

  test('extracts the stable route name from a plan dir', () => {
    expect(planBriefNameFromDir('plans/foo-bar')).toBe('foo-bar');
    expect(planBriefNameFromDir('/plans/foo-bar/')).toBe('foo-bar');
    expect(planBriefNameFromDir('')).toBeUndefined();
  });
});
