/**
 * workflowGraph.test.ts — the workflow graph + live-progress merge. DOM-free (bun:test).
 */
import { describe, expect, test } from 'bun:test';
import { buildWorkflowFlow } from './workflowGraph';
import type { WorkflowGraphSnapshotDTO, WorkflowRunStateDTO } from './dto';

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
});
