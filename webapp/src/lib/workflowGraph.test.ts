/**
 * workflowGraph.test.ts — the workflow graph + live-progress merge. DOM-free (bun:test).
 */
import { describe, expect, test } from 'bun:test';
import { buildWorkflowFlow, pickWorkflowGraphAgent } from './workflowGraph';
import type { AgentDTO, WorkflowGraphSnapshotDTO, WorkflowRunStateDTO } from './dto';

function agent(id: string, extra: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: id,
    status: 'working',
    repo: '/repo',
    worktree: '/repo/.worktrees/' + id,
    pending: [],
    lastActivity: 0,
    autonomyMode: 'assist',
    effectiveMode: 'assist',
    verificationState: 'unknown',
    availableActions: [],
    ...extra,
  };
}

function graphSnapshot(): WorkflowGraphSnapshotDTO {
  return { version: 1, name: 'demo', nodes: [{ id: 'start', kind: 'start' }], edges: [], start: 'start', exit: 'start' };
}

function linearGraph(): WorkflowGraphSnapshotDTO {
  return {
    version: 1,
    name: 'demo',
    nodes: [
      { id: 'start', kind: 'start', label: 'Start' },
      { id: 'a', kind: 'agent', label: 'Do A' },
      { id: 'b', kind: 'agent', label: 'Do B' },
      { id: 'exit', kind: 'exit', label: 'Exit' },
    ],
    edges: [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'exit' },
    ],
    start: 'start',
    exit: 'exit',
  };
}

describe('buildWorkflowFlow', () => {
  test('4-node linear graph → columns 0..3, all pending with no state', () => {
    const flow = buildWorkflowFlow(linearGraph());
    const colById = new Map(flow.nodes.map((n) => [n.id, n.col]));
    expect(colById.get('start')).toBe(0);
    expect(colById.get('a')).toBe(1);
    expect(colById.get('b')).toBe(2);
    expect(colById.get('exit')).toBe(3);
    expect(flow.nodes.every((n) => n.status === 'pending')).toBe(true);
    expect(flow.cols).toBe(4);
  });

  test('a rollup with 2 completed + 1 in_progress → statuses match', () => {
    const state: WorkflowRunStateDTO = {
      currentNode: 'b',
      visits: {},
      vars: {},
      rollup: [
        { label: 'Start', status: 'completed' },
        { label: 'Do A', status: 'completed' },
        { label: 'Do B', status: 'in_progress' },
      ],
    };
    const flow = buildWorkflowFlow(linearGraph(), state);
    const statusById = new Map(flow.nodes.map((n) => [n.id, n.status]));
    expect(statusById.get('start')).toBe('completed');
    expect(statusById.get('a')).toBe('completed');
    expect(statusById.get('b')).toBe('in_progress');
    expect(statusById.get('exit')).toBe('pending');
  });

  test('a node with retryTarget → one extra retry-kind edge, not double-counted against an existing normal edge', () => {
    const graph: WorkflowGraphSnapshotDTO = {
      version: 1,
      name: 'demo',
      nodes: [
        { id: 'start', kind: 'start' },
        { id: 'fixup', kind: 'agent', retryTarget: 'start' },
        { id: 'gate', kind: 'agent', retryTarget: 'fixup' }, // no normal edge back to fixup
        { id: 'exit', kind: 'exit' },
      ],
      edges: [
        { from: 'start', to: 'fixup' },
        { from: 'fixup', to: 'gate' },
        { from: 'gate', to: 'exit' },
        { from: 'gate', to: 'fixup' }, // an existing normal edge duplicating gate's retryTarget
      ],
      start: 'start',
      exit: 'exit',
    };
    const flow = buildWorkflowFlow(graph);
    const retryEdges = flow.edges.filter((e) => e.kind === 'retry');
    expect(retryEdges).toHaveLength(1);
    expect(retryEdges[0]).toMatchObject({ from: 'fixup', to: 'start' });
    // gate->fixup already exists as a normal edge — must not also appear as a retry edge
    expect(flow.edges.filter((e) => e.from === 'gate' && e.to === 'fixup')).toHaveLength(1);
  });

  // Regression guard: rollup entries carry only a `label` (workflow/executor.ts's rollup array),
  // never a node id, so two DISTINCT graph nodes sharing a label (e.g. an earlier stage and a later
  // stage both journaled as "Verify") can't be told apart from `rollup` alone. The old label-keyed
  // lookup let the SECOND node inherit whatever status the label's most recent rollup entry carried
  // — a node that had never run could render 'completed' just because an earlier, same-labelled node
  // already finished.
  test('duplicate label across two distinct node ids → falls back to pending (indeterminate) instead of inheriting a sibling\'s status', () => {
    const graph: WorkflowGraphSnapshotDTO = {
      version: 1,
      name: 'demo',
      nodes: [
        { id: 'start', kind: 'start', label: 'Start' },
        { id: 'verify1', kind: 'command', label: 'Verify' },
        { id: 'fixup', kind: 'agent', label: 'Fix' },
        { id: 'verify2', kind: 'command', label: 'Verify' }, // distinct id, SAME label as verify1
        { id: 'exit', kind: 'exit', label: 'Exit' },
      ],
      edges: [
        { from: 'start', to: 'verify1' },
        { from: 'verify1', to: 'fixup' },
        { from: 'fixup', to: 'verify2' },
        { from: 'verify2', to: 'exit' },
      ],
      start: 'start',
      exit: 'exit',
    };
    // verify1 already ran and completed; the run is now sitting on fixup. verify2 has not started.
    const state: WorkflowRunStateDTO = {
      currentNode: 'fixup',
      visits: { start: 1, verify1: 1 },
      vars: {},
      rollup: [
        { label: 'Verify', status: 'completed' }, // verify1's completed run — the only rollup entry
      ],
    };
    const flow = buildWorkflowFlow(graph, state);
    const statusById = new Map(flow.nodes.map((n) => [n.id, n.status]));
    expect(statusById.get('verify1')).toBe('completed'); // resolved via ID-keyed `visits`, not the label
    expect(statusById.get('fixup')).toBe('in_progress'); // resolved via ID-keyed `currentNode`
    expect(statusById.get('verify2')).toBe('pending'); // NOT 'completed' — must not inherit verify1's status
  });
});

describe('pickWorkflowGraphAgent', () => {
  test('no candidates with a workflowGraph → undefined', () => {
    expect(pickWorkflowGraphAgent([agent('a'), agent('b')])).toBeUndefined();
  });

  test('a dead terminal-marked run alongside its live fork → the live one wins, not array order', () => {
    const dead = agent('dead', {
      status: 'stopped',
      workflowGraph: graphSnapshot(),
      workflowState: { currentNode: 'exit', visits: {}, vars: {}, rollup: [], terminal: { reason: 'ran-off-the-end' } },
      lastActivity: 100,
    });
    const live = agent('live', {
      status: 'working',
      workflowGraph: graphSnapshot(),
      workflowState: { currentNode: 'start', visits: {}, vars: {}, rollup: [] },
      lastActivity: 5, // older lastActivity than `dead` — liveness must win over recency here
    });
    // `dead` appears FIRST in the array — a plain `.find` would have picked it.
    expect(pickWorkflowGraphAgent([dead, live])?.id).toBe('live');
  });

  test('two live candidates → newest lastActivity wins within the same liveness tier', () => {
    const older = agent('older', { status: 'idle', workflowGraph: graphSnapshot(), lastActivity: 10 });
    const newer = agent('newer', { status: 'idle', workflowGraph: graphSnapshot(), lastActivity: 20 });
    expect(pickWorkflowGraphAgent([older, newer])?.id).toBe('newer');
  });

  test('agents without a workflowGraph are ignored even if they would otherwise outrank the candidate', () => {
    const noGraph = agent('no-graph', { status: 'working', lastActivity: 999 });
    const candidate = agent('candidate', { status: 'idle', workflowGraph: graphSnapshot(), lastActivity: 1 });
    expect(pickWorkflowGraphAgent([noGraph, candidate])?.id).toBe('candidate');
  });
});
