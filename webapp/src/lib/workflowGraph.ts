/**
 * workflowGraph.ts — turn a journaled `WorkflowGraphSnapshotDTO` (static topology) plus an
 * optional `WorkflowRunStateDTO` (live progress) into a layered DAG the UI can draw.
 *
 * Layout is in the spirit of planGraph.ts's column-by-depth approach: column = BFS depth from
 * `graph.start`, row = position within that column. The graph is journaled once and never
 * changes; only node status changes as the run progresses, so this is a pure merge at render
 * time — no fetch, no DOM: pure and unit-tested, like planGraph.ts.
 */

import type { AgentDTO, WorkflowGraphSnapshotDTO, WorkflowRunStateDTO } from './dto';

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
 * Merge static topology (`graph`) with live progress (`state`) at render time. Status per node
 * prefers the run state's ID-keyed fields — `currentNode` (in_progress) and `visits[id] > 0`
 * (completed) — over the `rollup` array, because `rollup` entries only carry a `label`, not a node
 * id (see `SingleAgentExecutor.rollup`, workflow/executor.ts). When neither ID-keyed signal applies,
 * fall back to matching `rollup` by label — but ONLY for a label that exactly one graph node carries.
 * A label shared by 2+ node ids (e.g. a retry loop whose retry-target node re-uses the same display
 * label as a later, distinct stage) can't be resolved from `rollup` at all: every entry for that
 * label would paint EVERY same-labelled node with whichever status was written last, which is how a
 * node that never ran could render as already 'completed'. Those are left 'pending' (indeterminate)
 * rather than risk a wrong-but-confident status. One synthetic dashed 'retry' edge is emitted per
 * node with a `retryTarget`, deduplicated against any normal edge that already connects the same pair
 * so a real edge is never double-drawn as a retry edge too.
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

  const idCountByLabel = new Map<string, number>();
  for (const n of graph.nodes) {
    const label = n.label ?? n.id;
    idCountByLabel.set(label, (idCountByLabel.get(label) ?? 0) + 1);
  }

  const nodes: WorkflowFlowNode[] = graph.nodes.map((n) => {
    const col = colOf.get(n.id) ?? 0;
    const row = rowCounters.get(col) ?? 0;
    rowCounters.set(col, row + 1);
    const label = n.label ?? n.id;
    let status: WorkflowFlowNode['status'];
    if (state?.currentNode === n.id) {
      status = 'in_progress';
    } else if ((state?.visits?.[n.id] ?? 0) > 0) {
      status = 'completed';
    } else if ((idCountByLabel.get(label) ?? 0) <= 1) {
      status = rollupByLabel.get(label) ?? rollupByLabel.get(n.id) ?? 'pending';
    } else {
      status = 'pending'; // label shared by multiple node ids and no ID-keyed signal — indeterminate
    }
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

/** Liveness rank for `pickWorkflowGraphAgent` — lower sorts first (more "live"). An agent whose
 *  persisted `workflowState.terminal` marker is set is dead (the exact gate `forkAvailable` is
 *  documented against, dto.ts): either it ran off the end, or it was superseded by a later fork —
 *  either way it always ranks behind every still-running record, no matter how recently it moved. */
function workflowLivenessRank(agent: AgentDTO): number {
  if (agent.workflowState?.terminal) return 3;
  if (agent.status === 'working' || agent.status === 'starting') return 0;
  if (agent.status === 'idle') return 1;
  return 2; // input, error, stopped
}

/**
 * Picks which of possibly several `workflowGraph`-carrying agents the graph overlay renders for a
 * task. `activeAgents.find(a => a.workflowGraph)` used to just grab array order — on a task with a
 * dead, terminal-marked run alongside its live fork/re-run, that's whichever one happened to load
 * first, often the dead one, freezing the overlay on a graph that will never move again while the
 * real run keeps going untracked. Ranks by liveness first (running/working > idle > input/error/
 * stopped, terminal-marked always last), then by `lastActivity` (newest wins) within a tier.
 */
export function pickWorkflowGraphAgent(agents: AgentDTO[]): AgentDTO | undefined {
  const candidates = agents.filter((a) => a.workflowGraph);
  if (candidates.length === 0) return undefined;
  return candidates.slice().sort((a, b) => workflowLivenessRank(a) - workflowLivenessRank(b) || b.lastActivity - a.lastActivity)[0];
}
