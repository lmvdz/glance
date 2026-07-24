import { describe, expect, test } from 'bun:test';
import { buildFleetEconomicsView } from './FleetEconomicsView';

describe('buildFleetEconomicsView', () => {
  test('aggregates GET /api/usage receipt rows by unit, lane, and model', () => {
    const economics = buildFleetEconomicsView([
      { agentId: 'agent-a', name: 'Alpha', lane: 'feature', model: 'model-a', toolCalls: 2, tokens: { total: 100 }, costUsd: 1.25 },
      { agentId: 'agent-b', name: 'Alpha', lane: 'hotfix', model: 'model-a', toolCalls: 3, tokens: { total: 70 }, costUsd: 0.75 },
      { agentId: 'agent-c', name: 'Beta', lane: 'feature', model: 'model-b', toolCalls: 5, tokens: { total: 30 }, costUsd: 2 },
    ]);

    expect(economics).toEqual({
      runs: 3,
      units: 3,
      tokens: 200,
      costUsd: 4,
      toolCalls: 10,
      byUnit: [
        { key: 'Alpha', runs: 2, units: 2, tokens: 170, costUsd: 2, toolCalls: 5 },
        { key: 'Beta', runs: 1, units: 1, tokens: 30, costUsd: 2, toolCalls: 5 },
      ],
      byLane: [
        { key: 'feature', runs: 2, units: 2, tokens: 130, costUsd: 3.25, toolCalls: 7 },
        { key: 'hotfix', runs: 1, units: 1, tokens: 70, costUsd: 0.75, toolCalls: 3 },
      ],
      byModel: [
        { key: 'model-a', runs: 2, units: 2, tokens: 170, costUsd: 2, toolCalls: 5 },
        { key: 'model-b', runs: 1, units: 1, tokens: 30, costUsd: 2, toolCalls: 5 },
      ],
    });
  });
});
