STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/dto.ts, webapp/src/lib/lineage.ts (new), webapp/src/lib/lineage.test.ts (new), webapp/src/lib/workflowGraph.ts (new), webapp/src/lib/workflowGraph.test.ts (new), webapp/src/components/TopologyPanel.tsx (new), webapp/src/components/WorkflowGraphOverlay.tsx (new), webapp/src/components/TaskDetail.tsx, webapp/src/App.tsx, src/server.ts, tests/trace-cache.test.ts (new)

## Goal

The parent/child forest and the workflow graph become visible in the live webapp (the app the user actually runs — `src/web/index.html` is the explicitly-designated legacy fallback and is left alone). This is a port + extension of prior art, not greenfield: the legacy `renderRace` (`src/web/index.html:1319–1341`) already builds a parent/child forest with a dangling-parentId-promotes-to-root rule (`:1323`: `all.filter(a => !a.parentId || !live.has(a.parentId))`) and the legacy `workflowRuns()`/`renderWorkflowRun()` (`:1259–1299`) already render `a.workflowState`'s rollup. `webapp/src/lib/dto.ts`'s `AgentDTO` (165–196) has none of `parentId`/`kind`/`workflow`/`workflowState`/the four concern-01/02/03 fields today — that gap is this concern's first fix.

This is the designated slice-4 cut point: if time runs short, ship steps 1–4 (dto mirror + lineage tree + graph overlay) and cut step 5 (trace drill-in redesign), which is additive and independently landable later. The trace endpoint (`/api/trace/:id`) already works today; step 5 makes it safe to put on a click path at scale, it doesn't unblock anything else in this slice.

Depends on concerns 01–03: the server-side fields (`parentId`/`parentNodeId`/`branchIndex`/`subagents`/`workflowGraph`) must actually be populated on live `AgentDTO`s for any of this to render real data.

## Approach

### 1. `webapp/src/lib/dto.ts` — mirror fields

Add to `AgentDTO` (165–196), matching `src/types.ts`'s server-side shape field-for-field:

```ts
export type AgentKind = "omp-operator" | "workflow" | "flue-service";

export interface WorkflowGraphNodeDTO {
  id: string;
  kind: string;
  label?: string;
  maxVisits?: number;
  overflow?: string;
  goalGate?: boolean;
  retryTarget?: string;
}
export interface WorkflowGraphEdgeDTO {
  from: string;
  to: string;
  label?: string;
  condition?: string;
}
export interface WorkflowGraphSnapshotDTO {
  version: 1;
  name: string;
  nodes: WorkflowGraphNodeDTO[];
  edges: WorkflowGraphEdgeDTO[];
  start: string;
  exit: string;
  maxNodeVisits?: number;
}
export interface WorkflowRunStateDTO {
  currentNode: string;
  visits: Record<string, number>;
  vars: Record<string, string>;
  outcome?: "succeeded" | "failed";
  preferredLabel?: string;
  rollup: { label: string; status: "in_progress" | "completed" }[];
}
export interface SubagentNodeDTO {
  id: string;
  agent: string;
  description?: string;
  status: string;
  task?: string;
  lastUpdate: number;
  index: number;
}

export interface AgentDTO {
  // ...existing fields unchanged...
  kind?: AgentKind;
  parentId?: string;
  parentNodeId?: string;
  branchIndex?: number;
  subagents?: SubagentNodeDTO[];
  workflow?: { path?: string; verify?: { command: string } };
  workflowState?: WorkflowRunStateDTO;
  workflowGraph?: WorkflowGraphSnapshotDTO;
}
```

No transport change needed — these already ride the existing `agent`/`roster` SSE events untyped-JSON; adding fields to the TS interface is purely additive typing that unlocks the rest of this concern.

### 2. `webapp/src/lib/lineage.ts` — port the legacy forest logic

```ts
import type { AgentDTO } from './dto';

export interface LineageNode {
  agent: AgentDTO;
  children: LineageNode[];
  /** True when this node's declared parentId doesn't resolve to a live roster agent — it is
   *  rendered as a promoted root with an "orphaned" badge instead of silently vanishing. */
  orphaned: boolean;
}

/**
 * Build the parent/child forest — a direct port of the legacy `renderRace` root/child split
 * (src/web/index.html:1323-1325), generalized to full recursive nesting (workflow branch trees
 * can be 2+ levels: a workflow run spawns branches, a branch can itself be a workflow). Dangling
 * parentId (parent removed from the roster) promotes the node to root rather than dropping it —
 * matching the legacy page's existing behavior, made explicit here via `orphaned`.
 */
export function buildLineageTree(agents: AgentDTO[]): LineageNode[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string, AgentDTO[]>();
  for (const a of agents) {
    if (a.parentId && byId.has(a.parentId)) {
      const list = childrenOf.get(a.parentId) ?? [];
      list.push(a);
      childrenOf.set(a.parentId, list);
    }
  }
  const build = (agent: AgentDTO): LineageNode => ({
    agent,
    orphaned: !!agent.parentId && !byId.has(agent.parentId),
    children: (childrenOf.get(agent.id) ?? [])
      .sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0) || a.startedAt! - b.startedAt!)
      .map(build),
  });
  return agents.filter((a) => !a.parentId || !byId.has(a.parentId)).map(build);
}
```

Unit tests in `lineage.test.ts`: flat roster (no lineage) → all roots, no children; simple parent+2-branch fan-out → 1 root with 2 sorted-by-branchIndex children; dangling `parentId` (parent id not in the agents array) → node appears as a root with `orphaned: true`; multi-level nesting (branch that is itself a workflow with its own branches) → 3-level tree.

### 3. `TopologyPanel.tsx` — fleet-wide tree view

New top-level panel (register as `view === 'topology'` in `App.tsx`, alongside the existing `'fleet-health'`/`'omp-graph'` entries at 54/57; add the nav entry wherever `WorkbenchPane` lists views — follow the existing pattern for `FleetHealthPanel`). Renders `buildLineageTree(agents)` as a collapsible tree (reuse existing status-badge/pill components from `AgentStatusStrip.tsx` for consistent styling), each node showing status, `kind`, and — for workflow nodes — a compact `workflowState.rollup` progress bar (port `renderWorkflowRun`'s bar logic, `src/web/index.html:1275–1284`, into JSX). An orphaned root gets a small "orphaned (parent removed)" badge per the design's `remove()` contract (step 5 below covers the write side).

### 4. `WorkflowGraphOverlay.tsx` + `webapp/src/lib/workflowGraph.ts` — static graph + live progress

New lib module mirroring `planGraph.ts`'s shape (layered DAG layout: column = depth from `start` via BFS/longest-path, row = position within column) but built from `WorkflowGraphSnapshotDTO` instead of plan concerns:

```ts
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
  kind: 'normal' | 'retry'; // retry ⇒ dashed in the renderer
}
export interface WorkflowFlow {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
}

/** Merge static topology (workflowGraph) with live progress (workflowState) at render time — the
 *  graph is journaled once and never changes; only node status changes as the run progresses. */
export function buildWorkflowFlow(graph: WorkflowGraphSnapshotDTO, state?: WorkflowRunStateDTO): WorkflowFlow {
  // layered layout identical in spirit to planGraph.ts's column-by-depth approach, seeded from graph.start
  // status per node: rollup entry match by label → 'completed'/'in_progress'; else 'pending'
  // one synthetic dashed edge per node.retryTarget, kind: 'retry'
}
```

`WorkflowGraphOverlay.tsx` renders `buildWorkflowFlow` output with SVG/CSS positioning modeled directly on `PlanFlowDiagram.tsx`'s existing node/edge rendering (box per node, line/arrow per edge, dashed style variant for `kind === 'retry'`). Wire into `TaskDetail.tsx` as a new collapsible section next to the existing "Plan flow" `<details>` block (1275–1301) — same pattern: a `<details>` summary with an expand-to-full-pane affordance, gated on `task`'s associated workflow agent having a `workflowGraph` present (`selectedAgent?.workflowGraph`).

Unit tests in `workflowGraph.test.ts`: a 4-node linear graph → columns 0..3, all `pending` with no state; feed a `rollup` with 2 `completed` + 1 `in_progress` → statuses match; a node with `retryTarget` → one extra `retry`-kind edge in the output, not double-counted if the graph also has a normal edge back to the same target.

### 5. Orphan-on-remove warning + trace drill-in redesign

**`remove()` warn-log** (`src/squad-manager.ts`, `remove()` at 2625–2636): before deleting, check for live children and warn:

```ts
private async remove(id: string, deleteWorktree: boolean): Promise<void> {
	const rec = this.agents.get(id);
	if (!rec) return;
	const liveChildren = [...this.agents.values()].filter((r) => r.dto.parentId === id && r.dto.id !== id);
	if (liveChildren.length) {
		this.log("warn", `removing agent "${rec.dto.name}" with ${liveChildren.length} live child(ren) — they become orphaned roots in the topology view`);
	}
	// ...unchanged...
}
```

**Trace drill-in** (`src/server.ts`, `/api/trace/:id` handler at 1188–1193, backed by `manager.trace()` at squad-manager.ts:2973–2979 → `readAllReceipts` + `buildTrace`): add a per-runId cache in front of the unbounded scan, keyed by the requested trace id, invalidated by receipt-count so a still-in-flight run (whose receipts keep growing) never serves stale data while a finalized run (receipt count stable) is served from cache:

```ts
const traceCache = new Map<string, { receiptCount: number; at: number; response: TraceResponse }>();
const TRACE_CACHE_TTL_MS = 30_000;

async function tracePayload(manager: SquadManager, id: string): Promise<TraceResponse> {
	const hit = traceCache.get(id);
	if (hit && Date.now() - hit.at < TRACE_CACHE_TTL_MS) return hit.response;
	const response = await manager.trace(id);
	// Only cache once the trace looks finalized (no receipt still mid-run) — cheap heuristic: no receipt
	// missing endedAt. A running trace is recomputed every call (small — receipts for one active run).
	if (response.receipts.every((r) => r.endedAt !== undefined)) {
		traceCache.set(id, { receiptCount: response.receipts.length, at: Date.now(), response });
	}
	return response;
}
```

Wire the handler at 1188–1193 through `tracePayload(manager, id)` instead of calling `manager.trace(id)` directly.

Client-side: `WorkflowGraphOverlay`'s node-click drill-in (or wherever the existing trace UI lives — check for an existing trace-viewer component; if none exists yet, this is new UI) renders `trace.rollup` (cost/duration/tool counts — never sampled, always present per `RunReceipt`'s rollup fields) as the primary view, with `trace.root`'s span waterfall shown underneath labeled "sampled — partial" whenever `trace.partial` is true (already computed by `buildTrace`, `src/spans.ts:356`).

New `tests/trace-cache.test.ts`: two calls to the cached path for a finalized run's id return the identical cached response object (assert reference equality or a spy-count on `manager.trace`); two calls for a run with an in-flight (no `endedAt`) receipt bypass the cache (spy-count `manager.trace` called twice); cache entry expires after `TRACE_CACHE_TTL_MS`.

## Verify

```bash
cd webapp && bun test src/lib/lineage.test.ts src/lib/workflowGraph.test.ts
cd webapp && bunx tsc --noEmit
cd webapp && bun run build
cd /home/lars/sui/omp-squad/.claude/worktrees/research-burr && export PATH="$PWD/node_modules/.bin:$PATH"
bun test tests/trace-cache.test.ts
bun test tests/squad.test.ts
```

Manual: `/run` the daemon + webapp, spawn a `.fabro` workflow with a `max_parallel` fan-out node, confirm the Topology panel shows the parent workflow agent with N branch children under it, the branch children show correct `branchIndex` ordering, and `TaskDetail`'s new graph overlay renders the static topology with the currently-active node highlighted from `workflowState`.

## Dependency graph

| concern | blockedBy |
|---|---|
| 04-webapp-topology-view | 01-boot-path-threading-and-durability, 02-subagent-merge-flush-lineage, 03-workflow-graph-journal |

## Resolution
Shipped in 6769407 + 87d7a76 (trace drill-in designated-cut actually shipped) (+ fixes cfeeade/9466a6f receipt-side traceId on the DTO replacing the wrong-id-space fallback, 879d4ea lineage cycle guards, b648fd1/d435762 trace cache per-manager + new-run revalidation, bad0d50 ID-keyed graph status + pickWorkflowGraphAgent liveness ranking + duration rollover + TopologyPanel subagent leaf rows). 
