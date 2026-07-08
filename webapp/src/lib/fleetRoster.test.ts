import { expect, test, describe } from 'bun:test';
import { buildFleetRoster, defaultSelection, totalRosterCount, calmLine } from './fleetRoster';
import { attentionItems, activeWork } from './insights';
import type { AgentDTO, FeatureDTO } from './dto';

// ───────────────────────────── fixtures (mirrors insights.test.ts) ─────────────────────────────

function agent(id: string, status: AgentDTO['status'], extra: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: id,
    status,
    repo: '/r',
    worktree: '/w',
    pending: [],
    lastActivity: 0,
    messageCount: 0,
    ...extra,
  } as AgentDTO;
}

function feature(id: string, extra: Partial<FeatureDTO> = {}): FeatureDTO {
  return {
    id,
    title: id,
    repo: '/r',
    stage: 'in-progress',
    agentIds: [],
    unlandedFiles: 0,
    divergent: false,
    blocked: false,
    statusCounts: {},
    readiness: { ready: false, state: 'no-candidate', blockers: [], nextAction: '' },
    ...extra,
  } as FeatureDTO;
}

describe('buildFleetRoster — state grouping', () => {
  test('sorts agents into needs/land/working/idle by their live state', () => {
    const agents = [
      agent('blocked-1', 'input', { pending: [{ id: 'r1', source: 'ui', kind: 'q', title: 'pick one', createdAt: 1 }], lastActivity: 5 }),
      agent('working-1', 'working', { lastActivity: Date.now() }),
      agent('land-1', 'idle', { landReady: true, lastActivity: 3, availableActions: ['land'] }),
      agent('idle-1', 'idle', { lastActivity: 2 }),
      agent('stopped-1', 'stopped', { lastActivity: 1 }),
    ];
    const attn = attentionItems({ agents });
    const work = activeWork(agents, []);
    const roster = buildFleetRoster(agents, attn, work);

    expect(roster.needs.map((r) => r.agent.id)).toEqual(['blocked-1']);
    expect(roster.land.map((r) => r.agent.id)).toEqual(['land-1']);
    expect(roster.working.map((r) => r.agent.id)).toEqual(['working-1']);
    expect(roster.idle.map((r) => r.agent.id).sort()).toEqual(['idle-1', 'stopped-1']);
  });

  test('a vetoed agent lands in NEEDS YOU, never LAND READY — the veto must never read as calm', () => {
    const agents = [
      agent('vetoed-1', 'idle', {
        landReady: true,
        availableActions: ['land'],
        validation: { verdict: 'veto', rationale: 'nope' } as AgentDTO['validation'],
        lastActivity: 1,
      }),
    ];
    const attn = attentionItems({ agents });
    const roster = buildFleetRoster(agents, attn, activeWork(agents, []));
    expect(roster.needs.map((r) => r.agent.id)).toEqual(['vetoed-1']);
    expect(roster.land).toEqual([]);
  });

  test('needs group is ranked by attentionItems severity/recency, not insertion order', () => {
    const agents = [
      agent('warn-stall', 'working', { lastActivity: Date.now() - 20 * 60_000 }), // stalled (warn)
      agent('crit-error', 'error', { lastActivity: 100, error: 'boom' }), // critical
    ];
    const attn = attentionItems({ agents });
    const roster = buildFleetRoster(agents, attn, activeWork(agents, []));
    expect(roster.needs.map((r) => r.agent.id)).toEqual(['crit-error', 'warn-stall']);
  });

  test('collision/resource attention items are virtual — not folded onto one agent row', () => {
    const agents = [agent('a1', 'working', { lastActivity: Date.now() }), agent('a2', 'working', { lastActivity: Date.now() })];
    const attn = attentionItems({
      agents,
      collisions: [{ file: 'x.ts', agents: [{ id: 'a1', name: 'a1' }, { id: 'a2', name: 'a2' }] }],
    });
    const roster = buildFleetRoster(agents, attn, activeWork(agents, []));
    expect(roster.needs).toEqual([]); // neither a1 nor a2 individually flagged
    expect(roster.virtualNeeds.map((i) => i.kind)).toEqual(['collision']);
  });

  test('a live agent joined to a real plan/feature (has a planDir) carries its planItem for the row line-2 chip', () => {
    const agents = [agent('a1', 'working', { featureId: 'f1', lastActivity: Date.now() })];
    const features = [feature('f1', { title: 'Ship the thing', planDir: 'plans/ship-the-thing', agentIds: ['a1'], workflowProgress: { done: 2, total: 5 } })];
    const attn = attentionItems({ agents });
    const roster = buildFleetRoster(agents, attn, activeWork(agents, features));
    expect(roster.working[0]?.planItem?.title).toBe('Ship the thing');
    expect(roster.working[0]?.planItem?.progress).toEqual({ done: 2, total: 5 });
  });

  test('an orphan agent\'s auto-wrapped single-agent pseudo-feature (no planDir) does NOT produce a plan chip', () => {
    // Live-driving found this: the backend wraps every un-featured agent in its own synthetic
    // "feature" (id `agent:<id>`, title = the agent's own name) purely for a uniform FeatureDTO
    // shape elsewhere. Without the planDir guard, every orphan row grew a redundant plan chip
    // naming the agent under itself.
    const agents = [agent('a1', 'working', { lastActivity: Date.now() })];
    const pseudoFeature = feature('agent:a1', { title: 'a1', stage: 'review', agentIds: ['a1'], planDir: undefined });
    const roster = buildFleetRoster(agents, attentionItems({ agents }), activeWork(agents, [pseudoFeature]));
    expect(roster.working[0]?.planItem).toBeUndefined();
  });

  test('un-staffed plans (in-progress feature, zero agents) form the trailing group', () => {
    const features = [feature('f1', { title: 'Dropped plan', agentIds: [] })];
    const roster = buildFleetRoster([], attentionItems({ agents: [] }), activeWork([], features));
    expect(roster.unstaffed).toHaveLength(1);
    expect(roster.unstaffed[0]?.item.title).toBe('Dropped plan');
  });

  test('a done/landed feature with no agent is not surfaced as unstaffed', () => {
    const features = [feature('f1', { stage: 'done', agentIds: [] })];
    const roster = buildFleetRoster([], attentionItems({ agents: [] }), activeWork([], features));
    expect(roster.unstaffed).toEqual([]);
  });
});

describe('defaultSelection', () => {
  test('prefers the top NEEDS-YOU row over everything else', () => {
    const agents = [agent('working-1', 'working', { lastActivity: 9 }), agent('blocked-1', 'input', { pending: [{ id: 'r', source: 'ui', kind: 'q', title: 't', createdAt: 1 }], lastActivity: 1 })];
    const roster = buildFleetRoster(agents, attentionItems({ agents }), activeWork(agents, []));
    expect(defaultSelection(roster)).toBe('blocked-1');
  });

  test('falls back down the group order when NEEDS YOU is empty', () => {
    const agents = [agent('idle-1', 'idle', { lastActivity: 1 }), agent('working-1', 'working', { lastActivity: Date.now() })];
    const roster = buildFleetRoster(agents, attentionItems({ agents }), activeWork(agents, []));
    expect(defaultSelection(roster)).toBe('working-1');
  });

  test('null when the roster is entirely empty (no agents, no unstaffed plans)', () => {
    const roster = buildFleetRoster([], attentionItems({ agents: [] }), activeWork([], []));
    expect(defaultSelection(roster)).toBeNull();
  });
});

describe('totalRosterCount', () => {
  test('counts agent rows across all four groups plus unstaffed plans', () => {
    const agents = [agent('w1', 'working', { lastActivity: 1 }), agent('i1', 'idle', { lastActivity: 1 })];
    const features = [feature('f1', { agentIds: [] })];
    const roster = buildFleetRoster(agents, attentionItems({ agents }), activeWork(agents, features));
    expect(totalRosterCount(roster)).toBe(3);
  });
});

describe('calmLine', () => {
  test('names the working count and room when there is headroom', () => {
    expect(calmLine(2, 3)).toBe('Nothing needs you · 2 working · room for 3');
  });

  test('falls back to "fleet idle" / "at cap" when there is nothing running / no headroom', () => {
    expect(calmLine(0, 0)).toBe('Nothing needs you · fleet idle · at cap');
  });
});
