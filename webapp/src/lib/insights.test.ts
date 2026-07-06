import { expect, test, describe } from 'bun:test';
import {
  computeCapacity,
  detectCollisions,
  churnHotspots,
  flappingAgents,
  automationDigest,
  attentionItems,
  pushRolling,
  activeWork,
  activeWorkAction,
  activeWorkDigest,
  type GovernancePayload,
  type HealthSample,
  type UsageRun,
  type HeatPayload,
  type AutomationRollup,
  type ServerActionItem,
} from './insights';
import type { AgentDTO, FeatureDTO } from './dto';

// ───────────────────────────── fixtures ─────────────────────────────

function gov(sample: Partial<HealthSample>, opts: Partial<GovernancePayload> = {}): GovernancePayload {
  const full: HealthSample = { rssMb: 150, load1: 1, ncpu: 8, freeRatio: 0.5, agents: 0, hosts: 0, ...sample };
  return {
    wipCap: 3,
    maxAgents: 8,
    health: { sample: full, warnings: opts.health?.warnings ?? [], at: Date.now() },
    ...opts,
  };
}

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

function run(agentId: string, files: string[], extra: Partial<UsageRun> = {}): UsageRun {
  return { agentId, name: agentId, repo: '/r', status: 'working', filesTouched: files, ...extra };
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

// ───────────────────────────── computeCapacity ─────────────────────────────

describe('computeCapacity', () => {
  test('healthy with room → counts roomFor and predicts the WIP cap as next limit', () => {
    const c = computeCapacity(gov({ agents: 1, rssMb: 150, load1: 1, ncpu: 8, freeRatio: 0.5 }));
    expect(c.used).toBe(1);
    expect(c.cap).toBe(3);
    expect(c.roomFor).toBe(2);
    expect(c.verdict).toBe('healthy');
    expect(c.headline).toContain('room for 2 more agents');
    expect(c.nextLimit).toContain('WIP cap');
  });

  test('singular phrasing for room for 1 more agent', () => {
    const c = computeCapacity(gov({ agents: 2, ncpu: 8, load1: 1 }));
    expect(c.roomFor).toBe(1);
    expect(c.headline).toContain('room for 1 more agent');
    expect(c.headline).not.toContain('1 more agents');
  });

  test('at WIP cap → warn, roomFor 0, queues headline', () => {
    const c = computeCapacity(gov({ agents: 3, ncpu: 8, load1: 1 }));
    expect(c.roomFor).toBe(0);
    expect(c.verdict).toBe('warn');
    expect(c.headline).toContain('at WIP cap');
    expect(c.headline).toContain('new work queues');
    expect(c.nextLimit).toContain('WIP cap');
  });

  test('load over 2×/CPU → critical, roomFor 0, names host load as the limit', () => {
    const c = computeCapacity(gov({ agents: 1, load1: 20, ncpu: 8 })); // 2.5×/cpu
    expect(c.verdict).toBe('critical');
    expect(c.roomFor).toBe(0);
    expect(c.nextLimit).toContain('host load');
    expect(c.headline).toContain('saturated');
    expect(c.loadPct).toBeGreaterThan(100);
  });

  test('low free memory → critical and names free memory', () => {
    const c = computeCapacity(gov({ agents: 1, freeRatio: 0.05, load1: 1, ncpu: 8 }));
    expect(c.verdict).toBe('critical');
    expect(c.nextLimit).toContain('free memory');
  });

  test('daemon RSS over ceiling → critical and names daemon memory', () => {
    const c = computeCapacity(gov({ agents: 1, rssMb: 2000, load1: 1, ncpu: 8 }));
    expect(c.verdict).toBe('critical');
    expect(c.memPct).toBeGreaterThan(100);
    expect(c.nextLimit).toContain('daemon memory');
  });

  test('daemon warnings present → critical even if computed metrics look fine', () => {
    const c = computeCapacity(gov({ agents: 1, load1: 1, ncpu: 8 }, { health: { sample: {} as HealthSample, warnings: ['custom warning'], at: 0 } }));
    // note: sample overridden above is empty; rebuild via direct payload to be precise
    const c2 = computeCapacity({
      wipCap: 3,
      maxAgents: 8,
      health: { sample: { rssMb: 150, load1: 1, ncpu: 8, freeRatio: 0.5, agents: 1, hosts: 0 }, warnings: ['runaway hosts'], at: 0 },
    });
    expect(c2.verdict).toBe('critical');
    expect(c2.nextLimit).toBe('runaway hosts');
    void c;
  });

  test('approaching a limit (load 80%) while under cap → warn', () => {
    const c = computeCapacity(gov({ agents: 0, load1: 12.8, ncpu: 8 })); // 1.6×/cpu = 80% of 2×
    expect(c.loadPct).toBeGreaterThanOrEqual(75);
    expect(c.verdict).toBe('warn');
  });

  test('null governance → safe zeros', () => {
    const c = computeCapacity(null);
    expect(c.used).toBe(0);
    expect(c.cap).toBe(0);
    expect(c.roomFor).toBe(0);
  });
});

// ───────────────────────────── detectCollisions ─────────────────────────────

describe('detectCollisions', () => {
  test('groups a file touched by 2 distinct live agents', () => {
    const agents = [agent('a', 'working'), agent('b', 'working')];
    const runs = [run('a', ['src/x.ts']), run('b', ['src/x.ts'])];
    const cols = detectCollisions(runs, agents);
    expect(cols).toHaveLength(1);
    expect(cols[0].file).toBe('src/x.ts');
    expect(cols[0].agents.map((a) => a.id)).toEqual(['a', 'b']);
  });

  test('same agent twice on a file is NOT a collision', () => {
    const agents = [agent('a', 'working')];
    const runs = [run('a', ['src/x.ts']), run('a', ['src/x.ts'])];
    expect(detectCollisions(runs, agents)).toHaveLength(0);
  });

  test('ignores files touched only by a non-live (stopped/error) agent', () => {
    const agents = [agent('a', 'working'), agent('b', 'stopped')];
    const runs = [run('a', ['src/x.ts']), run('b', ['src/x.ts'])];
    expect(detectCollisions(runs, agents)).toHaveLength(0);
  });

  test('sorts by colliding-agent count desc', () => {
    const agents = [agent('a', 'working'), agent('b', 'working'), agent('c', 'working')];
    const runs = [
      run('a', ['hot.ts', 'cool.ts']),
      run('b', ['hot.ts', 'cool.ts']),
      run('c', ['hot.ts']),
    ];
    const cols = detectCollisions(runs, agents);
    expect(cols[0].file).toBe('hot.ts');
    expect(cols[0].agents).toHaveLength(3);
    expect(cols[1].file).toBe('cool.ts');
    expect(cols[1].agents).toHaveLength(2);
  });

  test('no live agents → empty', () => {
    expect(detectCollisions([run('a', ['x'])], [])).toEqual([]);
    expect(detectCollisions(null, null)).toEqual([]);
  });
});

// ───────────────────────────── churnHotspots ─────────────────────────────

describe('churnHotspots', () => {
  const heat: HeatPayload = {
    days: ['d1', 'd2', 'd3'],
    tree: [
      { id: 'src/a.ts', heat: [1, 2, 0] },
      { id: 'src/b.ts', heat: [0, 0, 5] },
      { id: 'src/cold.ts', heat: [0, 0, 0] },
    ],
  };

  test('ranks by total heat desc and drops zero-heat files', () => {
    const rows = churnHotspots(heat, []);
    expect(rows.map((r) => r.path)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(rows[0].heat).toBe(5);
    expect(rows[1].heat).toBe(3);
  });

  test('enriches each hotspot with distinct agent count', () => {
    const runs = [run('a', ['src/a.ts']), run('b', ['src/a.ts']), run('a', ['src/b.ts'])];
    const rows = churnHotspots(heat, runs);
    const a = rows.find((r) => r.path === 'src/a.ts')!;
    const b = rows.find((r) => r.path === 'src/b.ts')!;
    expect(a.agentCount).toBe(2);
    expect(b.agentCount).toBe(1);
  });

  test('respects the limit', () => {
    expect(churnHotspots(heat, [], 1)).toHaveLength(1);
  });

  test('null heat → empty', () => {
    expect(churnHotspots(null, [])).toEqual([]);
  });
});

// ───────────────────────────── flappingAgents ─────────────────────────────

describe('flappingAgents', () => {
  test('ranks agents at/above the threshold desc by errorTransitions1h', () => {
    const agents = [
      agent('a', 'error', { errorTransitions1h: 2 }),
      agent('b', 'error', { errorTransitions1h: 5 }),
      agent('c', 'idle', { errorTransitions1h: 1 }),
    ];
    const rows = flappingAgents(agents);
    expect(rows.map((r) => r.agentId)).toEqual(['b', 'a']);
    expect(rows[0].errorTransitions1h).toBe(5);
  });

  test('respects a custom minCount threshold', () => {
    const agents = [agent('a', 'error', { errorTransitions1h: 3 })];
    expect(flappingAgents(agents, 4)).toEqual([]);
    expect(flappingAgents(agents, 3)).toHaveLength(1);
  });

  test('undefined errorTransitions1h and null/undefined agents → empty', () => {
    expect(flappingAgents([agent('a', 'error')])).toEqual([]);
    expect(flappingAgents(null)).toEqual([]);
    expect(flappingAgents(undefined)).toEqual([]);
  });
});

// ───────────────────────────── automationDigest ─────────────────────────────

describe('automationDigest', () => {
  const roll = (loop: string, p: Partial<AutomationRollup> = {}): AutomationRollup => ({
    loop,
    events: 0,
    llmCalls: 0,
    found: 0,
    filed: 0,
    spawned: 0,
    errors: 0,
    lastAt: 0,
    ...p,
  });

  test('sums totals across loops and carries spend from usage', () => {
    const d = automationDigest(
      [roll('scout', { llmCalls: 5, filed: 2, found: 3 }), roll('dispatch', { found: 4, spawned: 1 })],
      { runs: [], costUsd: 1.23 },
    );
    expect(d.llmCalls).toBe(5);
    expect(d.ticketsFiled).toBe(2);
    expect(d.agentsSpawned).toBe(1);
    expect(d.candidates).toBe(7);
    expect(d.spentUsd).toBe(1.23);
  });

  test('flags "found >> spawned/filed" anomaly', () => {
    const d = automationDigest([roll('dispatch', { found: 6, spawned: 0, filed: 0 })], { runs: [] });
    expect(d.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(d.anomalies[0].loop).toBe('dispatch');
    expect(d.anomalies[0].message).toContain('spawned 0');
    expect(d.anomalies[0].message.toLowerCase()).toContain('cap');
  });

  test('flags dispatch saw candidates but spawned none even at low counts', () => {
    const d = automationDigest([roll('dispatch', { found: 1, spawned: 0, filed: 1 })], { runs: [] });
    expect(d.anomalies.some((a) => a.loop === 'dispatch' && a.message.includes('spawned none'))).toBe(true);
  });

  test('flags errors and scout budget exhaustion', () => {
    const d = automationDigest([roll('scout', { errors: 2, llmCalls: 30 })], { runs: [] }, 30);
    expect(d.anomalies.some((a) => a.message.includes('error'))).toBe(true);
    expect(d.anomalies.some((a) => a.message.includes('budget'))).toBe(true);
    expect(d.scoutBudget).toEqual({ used: 30, cap: 30 });
  });

  test('clean rollups → no anomalies', () => {
    const d = automationDigest([roll('scout', { llmCalls: 1, filed: 2, found: 2 }), roll('dispatch', { found: 2, spawned: 2 })], { runs: [] });
    expect(d.anomalies).toEqual([]);
  });

  test('silent loop past 3× its interval with no skip reason is a stuck anomaly', () => {
    const now = 1_000_000;
    // dispatch interval is 30s; 91s of silence with no skip reason → stuck.
    const d = automationDigest([roll('dispatch', { lastAt: now - 91_000 })], { runs: [] }, 30, now);
    expect(d.anomalies.some((a) => a.loop === 'dispatch' && a.message.includes('stuck'))).toBe(true);
    expect(d.idle).toEqual([]);
  });

  test('recent skip reason is healthy idle, not an anomaly', () => {
    const now = 1_000_000;
    const d = automationDigest([roll('dispatch', { lastAt: now - 20_000, lastSkipReason: 'WIP cap reached' })], { runs: [] }, 30, now);
    expect(d.anomalies.filter((a) => a.loop === 'dispatch')).toEqual([]);
    expect(d.idle).toEqual([{ loop: 'dispatch', reason: 'WIP cap reached', idleMs: 20_000 }]);
  });

  test('null inputs → zeros', () => {
    const d = automationDigest(null, null);
    expect(d.llmCalls).toBe(0);
    expect(d.spentUsd).toBe(0);
    expect(d.anomalies).toEqual([]);
  });
});

// ───────────────────────────── attentionItems ─────────────────────────────

describe('attentionItems', () => {
  test('blocked agent (status input) → critical answer item', () => {
    const items = attentionItems({ agents: [agent('a', 'input')] });
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('critical');
    expect(items[0].kind).toBe('blocked');
    expect(items[0].action?.kind).toBe('answer');
  });

  test('blocked agent via pending carries the requestId for the answer flow', () => {
    const a = agent('a', 'working', {
      pending: [{ id: 'req1', source: 'tool', kind: 'k', title: 'Approve?', createdAt: 100 }],
    });
    const items = attentionItems({ agents: [a] });
    expect(items[0].kind).toBe('blocked');
    expect(items[0].requestId).toBe('req1');
    expect(items[0].since).toBe(100);
  });

  test('errored agent → critical restart item', () => {
    const items = attentionItems({ agents: [agent('a', 'error', { error: 'boom' })] });
    expect(items[0].kind).toBe('error');
    expect(items[0].action?.kind).toBe('restart');
    expect(items[0].detail).toBe('boom');
  });

  test('errored agent with ≥2 errors/hr → flapping item, not plain error', () => {
    const items = attentionItems({ agents: [agent('a', 'error', { error: 'boom', errorTransitions1h: 3 })] });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('flapping');
    expect(items[0].severity).toBe('critical');
    expect(items[0].action?.kind).toBe('restart');
  });

  test('errored agent with 1 error/hr stays a plain error item', () => {
    const items = attentionItems({ agents: [agent('a', 'error', { error: 'boom', errorTransitions1h: 1 })] });
    expect(items[0].kind).toBe('error');
  });

  test('landReady agent → warn land item', () => {
    const items = attentionItems({ agents: [agent('a', 'idle', { landReady: true })] });
    expect(items[0].kind).toBe('land-ready');
    expect(items[0].severity).toBe('warn');
    expect(items[0].action?.kind).toBe('land');
  });

  test('blocked agent that is also landReady only emits the blocked item', () => {
    const items = attentionItems({ agents: [agent('a', 'input', { landReady: true })] });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('blocked');
  });

  test('vetoed land-ready agent → a critical "vetoed" row with the rationale, and NOT a calm land row', () => {
    const validation = { verdict: 'veto' as const, agreement: 0, confidence: 0.9, perCriterion: [], rationale: 'criterion 2 unmet' };
    const items = attentionItems({ agents: [agent('a', 'idle', { landReady: true, validation })] });
    const veto = items.find((i) => i.kind === 'vetoed');
    expect(veto).toBeDefined();
    expect(veto?.severity).toBe('critical');
    expect(veto?.detail).toContain('criterion 2 unmet');
    expect(veto?.action?.kind).toBe('view');
    expect(items.some((i) => i.kind === 'land-ready')).toBe(false); // the calm row is suppressed
  });

  test('collisions become warn view items', () => {
    const items = attentionItems({ collisions: [{ file: 'src/x.ts', agents: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] }] });
    expect(items[0].kind).toBe('collision');
    expect(items[0].action?.kind).toBe('view');
    expect(items[0].title).toContain('2 agents');
  });

  test('critical capacity → raise-cap resource item', () => {
    const items = attentionItems({
      capacity: { used: 1, cap: 3, roomFor: 0, verdict: 'critical', headline: 'saturated', memPct: 50, loadPct: 130 },
    });
    expect(items[0].kind).toBe('resource');
    expect(items[0].severity).toBe('critical');
    expect(items[0].action?.kind).toBe('raise-cap');
  });

  test('sorts critical → warn → ok', () => {
    const items = attentionItems({
      agents: [agent('land', 'idle', { landReady: true }), agent('err', 'error')],
    });
    expect(items.map((i) => i.severity)).toEqual(['critical', 'warn']);
    expect(items[0].kind).toBe('error');
    expect(items[1].kind).toBe('land-ready');
  });

  test('server health action-items fold in; duplicate agent rows are not double-counted', () => {
    const a = agent('a', 'input');
    const serverItems: ServerActionItem[] = [
      { id: 'pending:a:x', severity: 'high', source: 'tool', subject: 'a: blocked', rootCause: 'r', nextAction: 'n', agentId: 'a' },
      { id: 'health:load', severity: 'medium', source: 'health', subject: 'Fleet health warning', rootCause: 'load high', nextAction: 'n' },
    ];
    const items = attentionItems({ agents: [a], actionItems: serverItems });
    // one blocked (from roster) + one health (from server); the server pending dup is skipped
    expect(items.filter((i) => i.kind === 'blocked')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'resource')).toHaveLength(1);
    expect(items.find((i) => i.kind === 'resource')?.detail).toBe('load high');
  });

  test('nothing actionable → empty list', () => {
    const items = attentionItems({
      agents: [agent('a', 'working', { lastActivity: Date.now() }), agent('b', 'idle')],
      capacity: { used: 2, cap: 5, roomFor: 3, verdict: 'healthy', headline: 'ok', memPct: 10, loadPct: 10 },
    });
    expect(items).toEqual([]);
  });

  test('a working agent gone quiet past the stall threshold → warn stalled item with a steer action', () => {
    const items = attentionItems({ agents: [agent('a', 'working', { lastActivity: Date.now() - 20 * 60_000 })] });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('stalled');
    expect(items[0].severity).toBe('warn');
    expect(items[0].action?.kind).toBe('steer');
  });

  test('a working agent with recent activity is not flagged stalled', () => {
    const items = attentionItems({ agents: [agent('a', 'working', { lastActivity: Date.now() - 1000 })] });
    expect(items).toEqual([]);
  });

  test('a report on a working (non-input) agent surfaces as a non-blocking warn view item', () => {
    const a = agent('a', 'working', {
      lastActivity: Date.now(),
      reports: [{ id: 'r1', summary: 'unsure about X', proposal: 'proposed Y instead', createdAt: Date.now() }],
    });
    const items = attentionItems({ agents: [a] });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('report');
    expect(items[0].severity).toBe('warn');
    expect(items[0].action?.kind).toBe('view');
    expect(items[0].detail).toContain('unsure about X');
    expect(items[0].detail).toContain('proposed Y instead');
    // Non-blocking: the report must never be modeled as/alongside a blocked row, and the agent's own
    // status/effectiveMode (not read by attentionItems at all) are untouched by this function.
    expect(a.status).toBe('working');
  });

  test('a blocked agent with a report only emits the blocked item (priority order, not a double row)', () => {
    const items = attentionItems({
      agents: [agent('a', 'input', { reports: [{ id: 'r1', summary: 'unsure', createdAt: Date.now() }] })],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('blocked');
  });
});

// ───────────────────────────── pushRolling ─────────────────────────────

describe('pushRolling', () => {
  test('appends within the cap', () => {
    expect(pushRolling([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });

  test('drops the oldest when over the cap', () => {
    expect(pushRolling([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  test('starts from empty', () => {
    expect(pushRolling([], 1)).toEqual([1]);
  });
});

// ───────────────────────────── activeWork ─────────────────────────────

describe('activeWork', () => {
  test('joins a working agent to its feature, carrying activity + progress', () => {
    const items = activeWork(
      [agent('a1', 'working', { featureId: 'f1', activity: 'running vitest', todo: { done: 7, total: 10 }, lastActivity: 100 })],
      [feature('f1', { title: 'Visual Plan Demo', planDir: 'plans/visual-plan-demo', workflowProgress: { done: 7, total: 10 } })],
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Visual Plan Demo');
    expect(items[0].planDir).toBe('plans/visual-plan-demo');
    expect(items[0].status).toBe('working');
    expect(items[0].progress).toEqual({ done: 7, total: 10 });
    expect(items[0].headline).toBe('a1 · running vitest · 7/10');
    expect(items[0].agents[0].note).toBe('running vitest');
  });

  test('links an agent via feature.agentIds even with no featureId on the agent', () => {
    const items = activeWork(
      [agent('a1', 'working', { activity: 'editing', lastActivity: 1 })],
      [feature('f1', { title: 'Linked', agentIds: ['a1'] })],
    );
    expect(items).toHaveLength(1);
    expect(items[0].featureId).toBe('f1');
    expect(items[0].agents.map((a) => a.id)).toEqual(['a1']);
  });

  test('sorts errored → blocked → land-ready → working → idle', () => {
    const items = activeWork(
      [
        agent('work', 'working', { featureId: 'fw', lastActivity: 5 }),
        agent('err', 'error', { featureId: 'fe', error: 'boom', lastActivity: 5 }),
        agent('blk', 'input', { featureId: 'fb', pending: [{ id: 'p1', source: 'tool', kind: 'decision', title: 'Need a decision', createdAt: 1 }], lastActivity: 5 }),
        agent('land', 'idle', { featureId: 'fl', landReady: true, lastActivity: 5 }),
      ],
      [feature('fw'), feature('fe'), feature('fb'), feature('fl')],
    );
    expect(items.map((i) => i.status)).toEqual(['errored', 'blocked', 'land-ready', 'working']);
    expect(items[0].headline).toBe('err errored — boom');
    expect(items[1].headline).toBe('blk is waiting on you — Need a decision');
  });

  test('surfaces an in-progress feature with no agent as idle/staffable', () => {
    const items = activeWork([], [feature('f1', { title: 'Dropped', stage: 'in-progress' })]);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('idle');
    expect(items[0].headline).toBe('in progress — no agent attached, staffable');
  });

  test('excludes done and landed features, and planned features with no agent', () => {
    const items = activeWork(
      [],
      [feature('d', { stage: 'done' }), feature('l', { stage: 'landed' }), feature('p', { stage: 'planned' })],
    );
    expect(items).toHaveLength(0);
  });

  test('shows a live agent with no feature as its own row, titled by agent name', () => {
    const items = activeWork([agent('lonely', 'working', { activity: 'thinking', lastActivity: 1 })], []);
    expect(items).toHaveLength(1);
    expect(items[0].featureId).toBeUndefined();
    expect(items[0].title).toBe('lonely');
    expect(items[0].headline).toBe('lonely · thinking');
  });

  test('collapses multiple agents on one feature, leading with the most urgent', () => {
    const items = activeWork(
      [
        agent('a1', 'working', { featureId: 'f1', activity: 'building', lastActivity: 2 }),
        agent('a2', 'error', { featureId: 'f1', error: 'crash', lastActivity: 1 }),
      ],
      [feature('f1', { title: 'Shared' })],
    );
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('errored');
    expect(items[0].headline).toBe('a2 +1 errored — crash');
    expect(items[0].agents).toHaveLength(2);
  });

  test('ignores stopped/terminal agents (no active work from them)', () => {
    const items = activeWork([agent('s', 'stopped', { featureId: 'f1', lastActivity: 1 })], [feature('f1', { stage: 'planned' })]);
    expect(items).toHaveLength(0);
  });
});

// ───────────────────────────── activeWorkDigest ─────────────────────────────

describe('activeWorkDigest', () => {
  test('empty → an explicit nothing-in-flight sentence', () => {
    expect(activeWorkDigest([])).toContain('nothing is being worked on right now');
  });

  test('renders title, status label, headline, and issue identifier', () => {
    const items = activeWork(
      [agent('a1', 'working', { featureId: 'f1', activity: 'running vitest', issue: { id: 'i1', identifier: 'OMPSQ-42', name: 'Do the thing' }, lastActivity: 1 })],
      [feature('f1', { title: 'Visual Plan Demo' })],
    );
    const digest = activeWorkDigest(items);
    expect(digest).toContain('what\'s being worked on right now (1 active)');
    expect(digest).toContain('"Visual Plan Demo" — working: a1 · running vitest [OMPSQ-42]');
  });

  test('caps the list and notes how many more', () => {
    const agents = Array.from({ length: 10 }, (_, i) => agent(`a${i}`, 'working', { featureId: `f${i}`, lastActivity: i }));
    const features = Array.from({ length: 10 }, (_, i) => feature(`f${i}`));
    const digest = activeWorkDigest(activeWork(agents, features), 8);
    expect(digest).toContain('(10 active)');
    expect(digest).toContain('…and 2 more');
    expect(digest.split('\n- ').length - 1).toBe(8);
  });

  test('appends the next move for actionable rows, but not for plain working ones', () => {
    const blocked = activeWork(
      [agent('blk', 'input', { featureId: 'fb', pending: [{ id: 'p1', source: 'tool', kind: 'decision', title: 'Need a decision', createdAt: 1 }], lastActivity: 5 })],
      [feature('fb', { title: 'Stuck plan' })],
    );
    expect(activeWorkDigest(blocked)).toContain('→ answer');
    const working = activeWork([agent('w', 'working', { featureId: 'fw', activity: 'building', lastActivity: 1 })], [feature('fw', { title: 'Busy plan' })]);
    expect(activeWorkDigest(working)).not.toContain('→');
  });
});

// ───────────────────────────── activeWorkAction ─────────────────────────────

describe('activeWorkAction', () => {
  test('errored → restart, targeting the errored agent', () => {
    const [item] = activeWork([agent('err', 'error', { featureId: 'f1', error: 'boom', lastActivity: 1 })], [feature('f1')]);
    expect(activeWorkAction(item)).toEqual({ kind: 'restart', label: 'Restart', agentId: 'err' });
  });

  test('blocked with a pending request → answer, carrying the request id', () => {
    const [item] = activeWork(
      [agent('blk', 'input', { featureId: 'f1', pending: [{ id: 'req-7', source: 'tool', kind: 'decision', title: 'Approve?', createdAt: 1 }], lastActivity: 1 })],
      [feature('f1')],
    );
    expect(activeWorkAction(item)).toEqual({ kind: 'answer', label: 'Answer', agentId: 'blk', requestId: 'req-7' });
  });

  test('land-ready on a plan → feature-level land (no agent target)', () => {
    const [item] = activeWork([agent('a', 'idle', { featureId: 'f1', landReady: true, lastActivity: 1 })], [feature('f1')]);
    expect(activeWorkAction(item)).toEqual({ kind: 'land', label: 'Land' });
  });

  test('land-ready on an orphan agent → land that agent', () => {
    const [item] = activeWork([agent('lone', 'idle', { landReady: true, lastActivity: 1 })], []);
    expect(activeWorkAction(item)).toEqual({ kind: 'land', label: 'Land', agentId: 'lone' });
  });

  test('un-staffed in-progress plan → staff a unit', () => {
    const [item] = activeWork([], [feature('f1', { title: 'Dropped', stage: 'in-progress' })]);
    expect(activeWorkAction(item)).toEqual({ kind: 'staff', label: 'Staff a unit' });
  });

  test('a plainly working agent → open the console', () => {
    const [item] = activeWork([agent('w', 'working', { featureId: 'f1', activity: 'building', lastActivity: 1 })], [feature('f1')]);
    expect(activeWorkAction(item)).toEqual({ kind: 'view', label: 'Open console', agentId: 'w' });
  });
});
