/**
 * workflowGraph.ts — turn a journaled `WorkflowGraphSnapshotDTO` (static topology) plus an
 * optional `WorkflowRunStateDTO` (live progress) into a layered DAG the UI can draw.
 *
 * Layout is in the spirit of planGraph.ts's column-by-depth approach: column = BFS depth from
 * `graph.start`, row = position within that column. The graph is journaled once and never
 * changes; only node status changes as the run progresses, so this is a pure merge at render
 * time — no fetch, no DOM: pure and unit-tested, like planGraph.ts.
 */

import type { WorkflowGraphSnapshotDTO, WorkflowRunStateDTO } from './dto';

export interface WorkflowFlowNode {
  id: string;
  kind: string;
  label: string;
  col: number;
  row: number;
  status: 'pending' | 'in_progress' | 'completed';
  retryTarget?: string;
}

export interface WorkflowFlowEdge {
  from: string;
  to: string;
  label?: string;
  condition?: string;
  /** 'retry' ⇒ a synthetic edge derived from a node's `retryTarget`, dashed in the renderer. */
  kind: 'normal' | 'retry';
}

export interface WorkflowFlow {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  cols: number;
  rows: number;
}

/** BFS layering from `start`: a node's column is the shortest number of hops from start.
 *  Nodes unreachable from start (shouldn't happen in a well-formed graph, but defensively
 *  handled) are placed in column 0 alongside start rather than dropped. */
function assignColumns(nodeIds: string[], start: string, outgoing: Map<string, string[]>): Map<string, number> {
  const col = new Map<string, number>();
  const queue: string[] = [];
  if (nodeIds.includes(start)) {
    col.set(start, 0);
    queue.push(start);
  }
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const depth = col.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      if (col.has(next)) continue;
      col.set(next, depth + 1);
      queue.push(next);
    }
  }
  for (const id of nodeIds) if (!col.has(id)) col.set(id, 0);
  return col;
}

/**
 * Merge static topology (`graph`) with live progress (`state`) at render time. Status per node:
 * a `rollup` entry whose label matches the node's label (falling back to its id) determines
 * in_progress/completed; nodes with no matching rollup entry are 'pending'. One synthetic dashed
 * 'retry' edge is emitted per node with a `retryTarget`, deduplicated against any normal edge
 * that already connects the same pair so a real edge is never double-drawn as a retry edge too.
 */
export function buildWorkflowFlow(graph: WorkflowGraphSnapshotDTO, state?: WorkflowRunStateDTO): WorkflowFlow {
  const nodeIds = graph.nodes.map((n) => n.id);
  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e.to);
    outgoing.set(e.from, list);
  }

  const colOf = assignColumns(nodeIds, graph.start, outgoing);
  const rowCounters = new Map<number, number>();

  const rollupByLabel = new Map<string, 'in_progress' | 'completed'>();
  for (const entry of state?.rollup ?? []) rollupByLabel.set(entry.label, entry.status);

  const nodes: WorkflowFlowNode[] = graph.nodes.map((n) => {
    const col = colOf.get(n.id) ?? 0;
    const row = rowCounters.get(col) ?? 0;
    rowCounters.set(col, row + 1);
    const label = n.label ?? n.id;
    const status = rollupByLabel.get(label) ?? rollupByLabel.get(n.id) ?? 'pending';
    return { id: n.id, kind: n.kind, label, col, row, status, retryTarget: n.retryTarget };
  });

  const normalPairs = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
  const edges: WorkflowFlowEdge[] = graph.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, condition: e.condition, kind: 'normal' as const }));
  for (const n of graph.nodes) {
    if (!n.retryTarget) continue;
    const key = `${n.id}->${n.retryTarget}`;
    if (normalPairs.has(key)) continue; // a real edge already connects this pair — don't double-draw it
    edges.push({ from: n.id, to: n.retryTarget, kind: 'retry' });
  }

  const cols = nodes.reduce((m, n) => Math.max(m, n.col + 1), 0);
  const rows = [...rowCounters.values()].reduce((m, r) => Math.max(m, r), 0);
  return { nodes, edges, cols, rows };
}
