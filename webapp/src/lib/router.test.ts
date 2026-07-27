import { describe, expect, test } from 'bun:test';
import { gateVerdictHref, hubHref, parseHubHash, shouldColdBootFleet, unitHref, workbenchHref } from './router';

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

  test('a `?push=1` marker on a channel route is stripped, not glued onto the channel id', () => {
    // src/voice-attention.ts's push deep link is exactly this shape: `/#/channel/<id>?push=1`. A
    // fragment has no browser-parsed query string, so without stripping this ourselves the id would
    // literally become "room-1?push=1" — a channel that doesn't exist, silently landing nowhere.
    expect(parseHubHash('#/channel/room-1?push=1')).toEqual({ kind: 'hub', channelId: 'room-1' });
    expect(parseHubHash('#/channel/room-1?push=1&view=diff')).toEqual({ kind: 'hub', channelId: 'room-1' });
  });

  test('demoted workbench routes stay behind the hub shell', () => {
    expect(workbenchHref('capabilities')).toBe('#/workbench/capabilities');
    expect(parseHubHash('#/workbench/capabilities')).toEqual({ kind: 'workbench', view: 'capabilities' });
  });

  test('the graph dissolves into the room, under both of its spellings', () => {
    // The Observe surface was a full-viewport dashboard from a design locked before the room-threads
    // pivot. 01-room answers the same question deliberately smaller — FLEET PULSE with a sentence
    // under it — and a product whose standing law is that watching should not be necessary cannot
    // also ship a watching screen.
    expect(parseHubHash('#/workbench/graph')).toEqual({ kind: 'hub', channelId: 'fleet' });
    expect(parseHubHash('#/workbench/omp-graph')).toEqual({ kind: 'hub', channelId: 'fleet' });
  });

  test('every old way of opening a unit lands in the room, standing at that node', () => {
    // The workbench step-in screen is gone; both of its URLs stay valid and arrive at the unit's own
    // room, which answers the same questions in the frame the reference draws.
    expect(parseHubHash('#/intervene/agent%201')).toEqual({ kind: 'hub', channelId: 'node:agent 1' });
    expect(parseHubHash('#/agent/agent%201')).toEqual({ kind: 'hub', channelId: 'node:agent 1' });
    expect(parseHubHash('#/workbench/intervene')).toEqual({ kind: 'hub', channelId: 'fleet' });
    expect(unitHref('agent 1')).toBe('#/channel/node%3Aagent%201');
    expect(workbenchHref('intervene', 'agent 1')).toBe(unitHref('agent 1'));
  });

  test('the fleet roster dissolves into the room rather than 404ing', () => {
    // FLEET PULSE says whether the fleet is calm; the standing tree says where everything is. There is
    // no roster page left for this URL to reach, and landing on nothing would be worse than landing home.
    expect(parseHubHash('#/workbench/fleet')).toEqual({ kind: 'hub', channelId: 'fleet' });
    expect(parseHubHash('#/workbench/not-a-view')).toEqual({ kind: 'hub', channelId: 'fleet' });
  });

  test('gate verdict proof route keeps channel and entry ids', () => {
    expect(gateVerdictHref('ops/night', 'entry:42')).toBe('#/gate-verdict/ops%2Fnight/entry%3A42');
    expect(parseHubHash('#/gate-verdict/ops%2Fnight/entry%3A42')).toEqual({ kind: 'workbench', view: 'gate-verdict', id: 'ops/night\u0000entry:42' });
    expect(workbenchHref('gate-verdict', 'ops/night\u0000entry:42')).toBe('#/gate-verdict/ops%2Fnight/entry%3A42');
  });

  test('task route opens a specific TaskDetail DAG surface', () => {
    expect(parseHubHash('#/workbench/task/feat%201')).toEqual({ kind: 'workbench', view: 'task', id: 'feat 1' });
    expect(workbenchHref('task', 'feat 1')).toBe('#/workbench/task/feat%201');
  });
});
