STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/workflow/types.ts, src/workflow-driver.ts, src/squad-manager.ts, tests/workflow-journal.test.ts (new)

## Goal

Every workflow run journals its static graph topology exactly once, with a real `runId`, before its first node executes — so the UI (concern 04) can render intended structure with live progress overlaid instead of only ever showing where the run currently is. Parallel-branch agents carry structural lineage (`parentNodeId` + `branchIndex`) distinct from their mutable display `name`, so siblings of one fan-out node and cold-resume re-spawns are distinguishable in the tree.

Depends on concern 01: the `workflowGraph` field on `PersistedAgent`/`AgentDTO` (and its threading through all boot paths) and the `WorkflowGraphSnapshot` shell type must exist first; the `parentNodeId`/`branchIndex` fields on `CreateAgentOptions` must exist first. This concern populates that plumbing with real emission/consumption and threads the two branch-lineage fields end-to-end from `BranchSpec` to `create()`.

Verified emission-timing bug the design corrects: `runId` is assigned only inside `execRun` (`this.runId = resume?.runId ?? \`${this.opts.id}:${Date.now().toString(36)}\`;`, src/workflow-driver.ts:217) — never in `start()` (114–146). `start()` only calls `execRun` when resuming (`opts.resumeState` set, 142–145); the first-ever run begins via `prompt()` (163–170), which also calls `execRun`. Emitting the graph event in `start()` would (a) stamp it with `emitJournal`'s fallback bogus runId (`\`${this.opts.id}:pending\`` — see `emitJournal`, 262–264) for every first run, since `this.runId` is still `""` at that point, and (b) never fire again on a resumed/second run through the same driver instance. Emitting at the *top* of `execRun`, immediately after the `this.runId = ...` assignment (217), fixes both: correct runId always, fires exactly once per run (including resumes), and never fires for a created-but-never-prompted agent (an agent that's spawned but killed before its first `prompt()`/resume never calls `execRun` at all).

## Approach

### 1. Extend `WorkflowGraphSnapshot` node shape (`src/workflow/types.ts`)

Concern 01 defined the shell (`WorkflowGraphNode` without `retryTarget`). Add it now:

```ts
export interface WorkflowGraphNode {
	id: string;
	kind: NodeKind;
	label?: string;
	maxVisits?: number;
	overflow?: string;
	goalGate?: boolean;
	/** On-failure routing target (WorkflowNode.retryTarget). Rendered as a dashed failure edge by the
	 *  webapp overlay — its omission would make failing runs visibly "jump" with no drawn edge. */
	retryTarget?: string;
}
```

Add `"workflow.graph"` to the `WorkflowJournalEvent["type"]` union (already added as a shell member by concern 01 — verify, else add here) and confirm the `graph?: WorkflowGraphSnapshot` field is present on `WorkflowJournalEvent` (106–133).

### 2. Build + emit the snapshot (`src/workflow-driver.ts`)

Add a pure builder (module-level function, no `this`):

```ts
function buildGraphSnapshot(wf: Workflow): WorkflowGraphSnapshot {
	return {
		version: 1,
		name: wf.name,
		start: wf.start,
		exit: wf.exit,
		maxNodeVisits: wf.maxNodeVisits,
		nodes: [...wf.nodes.values()].map((n) => ({
			id: n.id,
			kind: n.kind,
			label: n.label,
			maxVisits: n.maxVisits,
			overflow: n.overflow,
			goalGate: n.goalGate,
			retryTarget: n.retryTarget,
		})),
		edges: wf.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, condition: e.condition })),
	};
}
```

In `execRun` (216–247), immediately after the `runId` assignment (217) and before the `emit("event", { type: "agent_start" })` (218):

```ts
this.runId = resume?.runId ?? `${this.opts.id}:${Date.now().toString(36)}`;
this.emitJournal({ type: "workflow.graph", graph: buildGraphSnapshot(this.wf!) });
this.emit("event", { type: "agent_start" });
```

`this.wf` is guaranteed set by this point (`start()` sets it at 115–117 before `execRun` can be reached via either `prompt()` or the resume branch). `emitJournal` (262–264) already stamps `at`/`workflow`/`runId` — no change needed there since `this.runId` is now always correct at call time.

### 3. Consume in `onAgentEvent` (`src/squad-manager.ts`)

Add a new case in the switch (2677–2760), matching the early-return pattern the existing `subagent_` branch uses (2667–2672) — **not** a `break`, since a `break` would fall through to the generic tail (`rec.dto.receipt = ...`, 2761–2764) and force an unnecessary `derive()`/`emitAgent` churn for a purely-structural event:

```ts
if (frame.type === "workflow_journal") {
	const event = frame.event as WorkflowJournalEvent;
	if (event.type === "workflow.graph" && event.graph) {
		rec.dto.workflowGraph = event.graph;
		rec.options.workflowGraph = event.graph;
		this.emitAgent(rec);
		void this.persist();
	}
	return;
}
```

Place this check either as its own early branch alongside the `subagent_` one (before the `switch`), or as a `case "workflow_journal":` inside the switch that `return`s instead of `break`s — either is acceptable; putting it before the switch (next to the `subagent_` check) is slightly more consistent with how that branch is already structured as a pre-switch early-return. All other `WorkflowJournalEvent` types (`workflow.node.*`, `workflow.human_gate.*`, `workflow.parallel.*`, `workflow.branch.*`, `workflow.verification.*`, `workflow.land.*`) remain **deliberately unconsumed** here — general journal persistence (a durable log of every journal event) is out of scope for this slice; it belongs to the separate hooks-convergence initiative referenced in the research brief.

Confirm the frame type string the manager receives is exactly `"workflow_journal"` — cross-check against how `WorkflowDriver` emits it. `emitJournal` (262–264) does `this.emit("event", { type: "workflow_journal", event: {...} satisfies WorkflowJournalEvent })`, so the outer envelope's `type` is `"workflow_journal"` and the inner `event.type` is the specific `WorkflowJournalEvent["type"]` (e.g. `"workflow.graph"`). Match on both levels as sketched above.

### 4. Branch lineage: `parentNodeId` + `branchIndex` (`BranchSpec` → `spawnFleetBranch` → `create()`)

`BranchSpec` (workflow-driver.ts:34–44) gains:

```ts
/** The node in the PARENT's graph this branch executes — structural lineage, kept distinct from `name`
 *  (mutable display string, identical across all siblings of one parallel node). */
parentNodeId?: string;
/** Distinguishes same-node siblings and cold-resume re-spawns of the same node. */
branchIndex?: number;
```

The `spawnBranch` wiring in `start()` (128) already passes `name: node.id` — that's the node id used as *display name*, not structural lineage (a later rename of the agent, or auto-uniqueification inside `create()`, would drift it from the true node id). Thread the node id AND a monotonic per-node branch counter explicitly:

```ts
spawnBranch: this.opts.fleet
	? (node, task, signal) => this.opts.fleet!.runBranch({
			name: node.id,
			task,
			model: node.model,
			approvalMode: this.opts.approvalMode,
			autonomy: this.autonomy(),
			proof: this.opts.proof,
			sessionId: this.sessionId(),
			signal,
			parentNodeId: node.id,
			branchIndex: this.nextBranchIndex(node.id),
		})
	: undefined,
```

Add a per-driver-instance counter keyed by node id (survives across a run's repeated visits to a parallel node, e.g. a fix-up loop that re-fans-out):

```ts
private branchIndexByNode = new Map<string, number>();
private nextBranchIndex(nodeId: string): number {
	const n = (this.branchIndexByNode.get(nodeId) ?? -1) + 1;
	this.branchIndexByNode.set(nodeId, n);
	return n;
}
```

`spawnFleetBranch` (squad-manager.ts:2216–2241) forwards both into `create()`'s opts (2237): add `parentNodeId: spec.parentNodeId, branchIndex: spec.branchIndex,` to the existing `create({ repo, name: spec.name, model: spec.model, approvalMode: spec.approvalMode, parentId, autoRoute: false, bypassCap: true })` call.

### 5. Rollout gap (documented, not fixed here)

Workflow agents already mid-run at deploy time get no `workflowGraph` until their next resume (a warm reconnect via `attachExisting` never re-enters `execRun`, so a live-but-not-yet-resumed agent has no journal to emit from; a cold adopt via `create()`/`adoptOrphanedAgents` DOES re-enter `execRun` on its next turn and self-heals). Note this in the PR description; no code change required — it is self-healing on the next natural resume.

### 6. Tests (new `tests/workflow-journal.test.ts`)

- Drive a `WorkflowDriver` through a fresh run (`prompt()`), capture emitted `"event"` frames, assert exactly one `workflow_journal`/`workflow.graph` event fires, before any `workflow.node.start`, with a `runId` matching the run's actual `runId` (not the `:pending` fallback) and `graph.nodes`/`graph.edges` matching the parsed `Workflow`'s node/edge count including a node with `retryTarget` set (use/extend an existing `.fabro` or synthesized-verify-loop fixture from `tests/workflow.test.ts`/`tests/workflow-catalog.test.ts`).
- Resume a driver from a `resumeState` (mirror `tests/workflow-resume.test.ts`'s harness) and assert the graph event fires again (once) on the resumed run, with the resumed run's `runId`.
- Assert a driver that's started but never prompted (no `execRun` call) emits zero `workflow.graph` events.
- Through `SquadManager`: assert `rec.dto.workflowGraph` / the persisted snapshot's `workflowGraph` populate after a workflow agent's first turn, and that other journal event types (e.g. `workflow.node.start`) do NOT populate any new manager-side field (guard against scope creep into general journal persistence).
- `spawnFleetBranch` / `BranchSpec` threading: fan out a `max_parallel` node with 2+ branches, assert each spawned agent's `PersistedAgent.parentNodeId` equals the node id and `branchIndex` is 0/1 respectively (distinct from `dto.name`, which may differ if `create()`'s uniqueification kicks in).

## Verify

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
bun test tests/workflow-journal.test.ts
bun test tests/workflow.test.ts tests/workflow-pipeline.test.ts tests/workflow-resume.test.ts
bunx tsc --noEmit
```

## Dependency graph

| concern | blockedBy |
|---|---|
| 03-workflow-graph-journal | 01-boot-path-threading-and-durability |
