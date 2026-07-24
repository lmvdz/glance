import { describe, expect, test } from 'bun:test';
import { gateVerdictHref, hubHref, parseHubHash, shouldColdBootFleet, workbenchHref } from './router';

describe('Hub hash router', () => {
  test('cold boot defaults to fleet channel', () => {
    expect(parseHubHash('')).toEqual({ kind: 'hub', channelId: 'fleet' });
    expect(parseHubHash('#fleet')).toEqual({ kind: 'hub', channelId: 'fleet' });
    expect(shouldColdBootFleet('')).toBe(true);
  });

  test('channel routes decode channel ids', () => {
    expect(parseHubHash('#/channel/ops%2Fnight')).toEqual({ kind: 'hub', channelId: 'ops/night' });
    expect(hubHref('ops/night')).toBe('#/channel/ops%2Fnight');
  });

  test('demoted workbench routes stay behind the hub shell', () => {
    expect(parseHubHash('#/workbench/graph')).toEqual({ kind: 'workbench', view: 'graph' });
    expect(parseHubHash('#/workbench/omp-graph')).toEqual({ kind: 'workbench', view: 'graph' });
    expect(workbenchHref('capabilities')).toBe('#/workbench/capabilities');
  });

  test('intervene route is deep-linkable', () => {
    expect(parseHubHash('#/intervene/agent%201')).toEqual({ kind: 'workbench', view: 'intervene', id: 'agent 1' });
    expect(workbenchHref('intervene', 'agent 1')).toBe('#/intervene/agent%201');
  });

  test('gate verdict proof route keeps channel and entry ids', () => {
    expect(gateVerdictHref('ops/night', 'entry:42')).toBe('#/gate-verdict/ops%2Fnight/entry%3A42');
    expect(parseHubHash('#/gate-verdict/ops%2Fnight/entry%3A42')).toEqual({ kind: 'workbench', view: 'gate-verdict', id: 'ops/night\u0000entry:42' });
    expect(workbenchHref('gate-verdict', 'ops/night\u0000entry:42')).toBe('#/gate-verdict/ops%2Fnight/entry%3A42');

  test('task route opens a specific TaskDetail DAG surface', () => {
    expect(parseHubHash('#/workbench/task/feat%201')).toEqual({ kind: 'workbench', view: 'task', id: 'feat 1' });
    expect(workbenchHref('task', 'feat 1')).toBe('#/workbench/task/feat%201');
  });
});
