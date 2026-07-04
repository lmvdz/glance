STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/dal/store.ts, src/factory-status.ts, src/subagents.ts, src/workflow/types.ts, tests/dal-store.test.ts, tests/squad-manager-boot-lineage.test.ts (new)

## Goal

The three lineage fields (`parentNodeId`, `branchIndex`, `subagents`, `workflowGraph` — four, plus the already-existing `parentId`) exist on `CreateAgentOptions`/`PersistedAgent`/`AgentDTO` and survive every boot path that reconstructs an `AgentRecord` from persisted state, not just the fresh-spawn path. This is the gating concern: concerns 02–04 add real *semantics* to `subagents`/`workflowGraph`, but none of that matters if the plumbing drops the fields on restart. Also lands two adjacent durability fixes whose evidence surfaced while auditing this exact code path: `persist()`'s write-amplification (chain-dedup, replacing a considered-and-rejected trailing timer) and `FileStore.save()`'s silently-swallowed write errors (rate-limited warn + a counter surfaced through factory status).

Verified reality this concern corrects: `create()` (src/squad-manager.ts:1967) builds both `persisted` (2091–2119) and `dto` (2121–2146) as **explicit field-literal objects** — nothing "rides along automatically". Two call sites re-enter `create()` with their own explicit opts literals reconstructed from a `PersistedAgent`: `adoptOrphanedAgents` (787–845, opts literal at 809–841) and `loadPersisted` (3545–3580, opts literal at 3555–3577). A third site, `attachExisting` (859–896), does not call `create()` at all — it hand-builds the `AgentDTO` literal directly (860–884) for the warm-reconnect path. Any field added to `PersistedAgent`/`AgentDTO`/`CreateAgentOptions` without touching all four sites silently vanishes on the next restart. This is not hypothetical: `scopeSource`, `workflowState`, and `sandbox` are already threaded through all four — this concern follows that exact established pattern for the four new fields.

## Approach

### 1. Type additions (`src/types.ts`)

On `CreateAgentOptions` (642–699), add near the existing `parentId` (674):

```ts
/** The node in the PARENT's workflow graph this branch executes (structural lineage — not a display
 *  string; distinct from `name`, which is mutable and identical across parallel siblings of one node). */
parentNodeId?: string;
/** Distinguishes same-node siblings (parallel fan-out) and cold-resume re-spawns of the same node. */
branchIndex?: number;
/** Persisted subagent tree snapshot (task-spawned children), carried opaquely through restore paths.
 *  Concern 02 owns the merge/dirty/flush semantics that populate and reconcile this on a live agent. */
subagents?: SubagentNode[];
/** Static workflow graph topology, captured once per run. Concern 03 owns emission (workflow.graph
 *  journal event) and the consuming switch case; this field is pure plumbing until then. */
workflowGraph?: WorkflowGraphSnapshot;
```

Add the same four fields (with the same docs) to `PersistedAgent` (574–613, alongside `parentId` at 602) and to `AgentDTO` (435–523, alongside `parentId` at 442). Import `SubagentNode` from `./subagents.ts` (already exported there, unchanged shape for this concern) and `WorkflowGraphSnapshot` from `./workflow/types.ts` (new type, defined below).

### 2. `WorkflowGraphSnapshot` shell type (`src/workflow/types.ts`)

Define the type now so the field above compiles and round-trips; concern 03 fills in real emission/consumption logic and may extend node fields (`retryTarget` etc.) without touching this concern's plumbing:

```ts
export interface WorkflowGraphNode {
	id: string;
	kind: NodeKind;
	label?: string;
	maxVisits?: number;
	overflow?: string;
	goalGate?: boolean;
	retryTarget?: string;
}

export interface WorkflowGraphEdge {
	from: string;
	to: string;
	label?: string;
	condition?: string;
}

/** Static topology snapshot of a workflow's DOT graph, journaled once per run so the UI can render
 *  intended structure with live progress overlaid. version:1 lets future shape changes be additive. */
export interface WorkflowGraphSnapshot {
	version: 1;
	name: string;
	nodes: WorkflowGraphNode[];
	edges: WorkflowGraphEdge[];
	start: string;
	exit: string;
	maxNodeVisits?: number;
}
```

Also add `"workflow.graph"` to `WorkflowJournalEvent["type"]` (106–119) and a `graph?: WorkflowGraphSnapshot` field on `WorkflowJournalEvent` (120–133) — concern 03 emits/consumes it; this concern only needs the union member to exist so its round-trip test (below) can construct a well-typed fixture without concern 03 having landed.

### 3. Thread through `create()` (src/squad-manager.ts:2091–2146)

Add to the `persisted` literal: `parentNodeId: opts.parentNodeId, branchIndex: opts.branchIndex, subagents: opts.subagents, workflowGraph: opts.workflowGraph,`. Add the same four to the `dto` literal (workflowGraph/subagents copied from `opts`, not from `persisted`, matching how `workflow`/`workflowState` already copy from `persisted` at 2143–2144 — here there's no derived value, so copy straight from `opts`).

### 4. Thread through `adoptOrphanedAgents` (787–845) and `loadPersisted` (3545–3580)

Both already forward `p.parentId` into the `create()` opts literal (821, 3565). Add immediately after: `parentNodeId: p.parentNodeId, branchIndex: p.branchIndex, subagents: p.subagents, workflowGraph: p.workflowGraph,`.

### 5. Thread through `attachExisting` (859–896)

Add to the hand-built `dto` literal (860–884), alongside `parentId: p.parentId` (876): `parentNodeId: p.parentNodeId, branchIndex: p.branchIndex, subagents: p.subagents, workflowGraph: p.workflowGraph,`.

### 6. `persist()` chain-dedup (squad-manager.ts:3514–3528)

Replace the current always-chain implementation with queued-write collapsing — at most one write queued behind the in-flight one, and every caller that arrives while a write is already queued joins that queued write's promise instead of adding a third:

```ts
private writeChain: Promise<void> = Promise.resolve();
private queuedWrite?: Promise<void>;
private writeInFlight = false;

/**
 * Chain-deduped writer: a burst of N persist() calls produces at most 2 store.save() invocations (the
 * in-flight one, plus one queued one that starts after it). Every caller's promise resolves only once a
 * write that snapshots state AFTER their call has completed — persistNow() reads live agent state at
 * write time, not at enqueue time, so the queued write durably contains every joiner's state. This keeps
 * `await persist()` a real durability barrier (stop() at :739 depends on it) while collapsing the
 * per-checkpoint chattiness a naive always-chain implementation has today.
 */
private async persist(): Promise<void> {
	if (this.queuedWrite) return this.queuedWrite;
	if (!this.writeInFlight) {
		this.writeInFlight = true;
		const p = this.persistNow().finally(() => { this.writeInFlight = false; });
		this.writeChain = p.catch(() => {});
		return p;
	}
	const queued = this.writeChain.then(() => {
		this.queuedWrite = undefined;
		this.writeInFlight = true;
		return this.persistNow().finally(() => { this.writeInFlight = false; });
	});
	this.queuedWrite = queued;
	this.writeChain = queued.catch(() => {});
	return queued;
}
```

`persistNow()` (3531–3542) is unchanged. This drops the trailing-timer approach considered during design (a timer firing after `stop()`'s barrier could clobber a successor daemon's state.json — a cross-process last-writer-wins race) in favor of dedup with zero new post-`stop()` write path.

### 7. `FileStore.save()` failure visibility (src/dal/store.ts:131–142)

```ts
private saveFailureCount = 0;
private lastSaveWarnAt = 0;

async save(snapshot: StateSnapshot): Promise<void> {
	try {
		const { feedback, ...state } = snapshot;
		const cap = normalizeCapabilitySnapshot(snapshot.capabilities);
		const body: StateSnapshot & { version: 1 } = { version: 1, agents: state.agents, transcripts: state.transcripts, features: state.features };
		if (cap.sources.length || cap.packs.length || cap.installs.length || cap.verifications.length || cap.audit.length) body.capabilities = cap;
		await writeFileDurable(this.stateFile, JSON.stringify(body, null, 2));
		if (feedback) await this.saveFeedback(feedback);
	} catch (err) {
		this.saveFailureCount++;
		const now = Date.now();
		if (now - this.lastSaveWarnAt > 60_000) {
			this.lastSaveWarnAt = now;
			console.error(`[FileStore] state.json save failed (${this.saveFailureCount} total this run): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** Cumulative save() failures this process — surfaced via factory-status since the topology
 *  guarantee (this concern's headline) now rests on this write actually landing. */
saveFailures(): number {
	return this.saveFailureCount;
}
```

Add `saveFailures?(): number;` to the `Store` interface (85–100) as optional (DbStore doesn't implement it — its per-write failures throw rather than swallow, so there's nothing to count).

In `src/factory-status.ts`: add `persistFailures: number` to `FactoryStatus` (83–92) and `BuildFactoryStatusInput` (104–114); copy it straight through in `buildFactoryStatus`. In `squad-manager.ts`'s `factoryStatus()` (3037–3058), pass `persistFailures: this.store.saveFailures?.() ?? 0`.

### 8. Round-trip tests (new `tests/squad-manager-boot-lineage.test.ts`)

One test per boot path, each: spawn a `SquadManager` against a temp `stateDir`, `create()` an agent with all four new fields set (plus a `SubagentNode[]` fixture and a `WorkflowGraphSnapshot` fixture), stop the manager (forces a `persist()`), then exercise the boot path under test and assert the fields on both the resulting `AgentDTO` and the *next* persisted snapshot (read `state.json` directly or via a fresh `FileStore.load()`):

- **reconnect**: keep the detached host alive (mirror the existing reconnect test pattern in `tests/squad.test.ts` / `tests/workflow-resume.test.ts`), boot a second `SquadManager` against the same `stateDir`, assert `reconnectLive` → `attachExisting` produced a DTO carrying all four fields.
- **adopt**: kill the host but leave the worktree with unlanded work, boot a second manager, assert `adoptOrphanedAgents` → `create()` produced a DTO carrying all four fields.
- **loadPersisted**: call `manager.loadPersisted()` directly against a `state.json` seeded with all four fields, assert the resulting DTO.

Also extend `tests/dal-store.test.ts` with: (a) a `FileStore.save()` round-trip that stores and loads a `PersistedAgent` carrying all four new fields and asserts byte-identical recovery; (b) a failure-visibility test — point `FileStore` at a stateDir under a read-only/nonexistent path (or inject an `fs.rename` failure via a mock) and assert `saveFailures()` increments without throwing.

### 9. `persist()` concurrency unit test

In `tests/squad.test.ts` (or a small new `tests/squad-persist-dedup.test.ts`): inject a `Store` whose `save()` counts invocations and add an artificial delay; fire N concurrent `persist()`-triggering operations; assert `save()` was invoked at most 2 times and every awaited call resolved after a `save()` that included its state (e.g. add an agent between two persist() calls fired back-to-back and assert the later resolves to a snapshot containing it).

## Verify

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
bun test tests/dal-store.test.ts
bun test tests/squad-manager-boot-lineage.test.ts
bun test tests/squad.test.ts
bun test tests/workflow-resume.test.ts   # existing reconnect/adopt coverage must still pass unmodified
bunx tsc --noEmit
```

## Dependency graph

| concern | blockedBy |
|---|---|
| 01-boot-path-threading-and-durability | — |

## Resolution
Shipped in aa7281f (+ audit fixes 848295b/f3209a4/d435762 era: lineageFieldsFrom() shared projection replacing five hand-threaded construction sites, persisted traceId, FileStore failure visibility verified live). Chain-dedup persist verified ≤2 writes/burst with dedicated test.
