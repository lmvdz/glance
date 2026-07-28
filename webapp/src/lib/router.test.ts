import { describe, expect, test } from 'bun:test';
import { canonicalHubHash, gateVerdictHref, hubHref, parseHubHash, reconcileHubHash, shouldColdBootFleet, unitHref, workbenchHref } from './router';

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

describe('canonicalHubHash / reconcileHubHash — the address bar must never disagree with the screen', () => {
  // Dead-doors audit finding 1: clicking "Fleet" or "Graph" left `#/workbench/fleet` (or /graph) in
  // the address bar while the room silently rendered underneath it — a screen and a URL naming two
  // different pages. `canonicalHubHash` is what the URL SHOULD say for a resolved route; a hash that
  // already matches it needs no correction (the common case for ordinary, well-formed navigation).

  test('a route round-trips to its own canonical hash — this is what makes normalization idempotent', () => {
    const cases: string[] = [
      '#fleet',
      '#/channel/ops%2Fnight',
      '#/channel/ops%2Fnight/entry/e1',
      '#/workbench/capabilities',
      '#/workbench/daily',
      '#/workbench/economics',
      '#/gate-verdict/ops%2Fnight/entry%3A42',
      '#/workbench/task/feat%201',
      '#/plan-reality',
      '#/plan-reality/feat-1',
      '#/plans',
      '#/plans/my-plan',
    ];
    for (const hash of cases) {
      const canonical = canonicalHubHash(parseHubHash(hash));
      expect(canonical).toBe(hash);
      // And applying it again changes nothing further — no oscillation.
      expect(canonicalHubHash(parseHubHash(canonical))).toBe(canonical);
    }
  });

  test('the retired "Fleet" and "Graph" workbench spellings correct the address bar to the real room hash', () => {
    expect(reconcileHubHash('#/workbench/fleet')).toEqual({ route: { kind: 'hub', channelId: 'fleet' }, correctedHash: '#fleet' });
    expect(reconcileHubHash('#/workbench/graph')).toEqual({ route: { kind: 'hub', channelId: 'fleet' }, correctedHash: '#fleet' });
    expect(reconcileHubHash('#/workbench/omp-graph')).toEqual({ route: { kind: 'hub', channelId: 'fleet' }, correctedHash: '#fleet' });
  });

  test('an unrecognized workbench view also corrects, rather than leaving a 404-shaped URL over a hub screen', () => {
    expect(reconcileHubHash('#/workbench/not-a-view')).toEqual({ route: { kind: 'hub', channelId: 'fleet' }, correctedHash: '#fleet' });
  });

  test('old unit-opening spellings correct to the modern channel hash', () => {
    expect(reconcileHubHash('#/intervene/agent%201').correctedHash).toBe(unitHref('agent 1'));
    expect(reconcileHubHash('#/agent/agent%201').correctedHash).toBe(unitHref('agent 1'));
  });

  test('an already-canonical hash needs no correction — ordinary navigation never rewrites the URL', () => {
    for (const hash of ['#fleet', '#/workbench/capabilities', '#/workbench/daily', '#/workbench/economics', '#/plan-reality', '#/plans']) {
      expect(reconcileHubHash(hash).correctedHash).toBeNull();
    }
  });
});
