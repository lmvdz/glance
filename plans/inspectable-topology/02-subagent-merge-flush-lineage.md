STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/subagents.ts, src/squad-manager.ts, tests/subagents.test.ts, tests/squad-manager-subagent-lineage.test.ts (new)

## Goal

The subagent tree becomes restart-surviving instead of in-memory-only: dirty-tracking + a merge-by-id flush turn `SubagentTracker` from a per-process cache into a durably persisted lineage layer, without losing a terminal status to a race or clobbering history on reattach. One read contract (`mergeSubagents()`) backs both the persisted snapshot and every live reader (`manager.subagents()`, `GET /api/agents/:id/subagents`), closing the two-freshness-of-truth gap the existing live endpoint has today.

Depends on concern 01: `PersistedAgent.subagents` / `AgentDTO.subagents` and their threading through all four boot paths must exist first — this concern populates and reconciles that field with real semantics instead of opaque pass-through.

Three corrections verified against `src/subagents.ts` that the naive version of this feature gets wrong:

1. **Dirty bit must be transition-based, not frame-type-based.** `LIFECYCLE_STATUS` (49–54) deliberately maps `subagent_lifecycle`'s `started/completed/failed/aborted` into the same vocabulary `subagent_progress` frames use (`running/…`). If a progress frame carrying the terminal status arrives before the lifecycle frame, the lifecycle frame's ingest becomes a no-change under `upsert`'s existing diff logic (176–214) — a dirty bit gated on "was this a lifecycle frame" would miss it and the terminal status would never get flushed. Fix: mark dirty on any node creation or any field transition inside `upsert`, using `upsert`'s own existing return value (already `true` iff something changed — see 177–214), not the frame type.
2. **Flush must merge, not overwrite.** Nothing calls `applySnapshot` today (grep confirms zero call sites — the method at 94–117 is dead code) and `restart()`'s `subs.clear()` (squad-manager.ts:2608) is the only caller of `.clear()`. A fresh `SubagentTracker` created on reattach (`attachExisting`, squad-manager.ts:887: `subs: new SubagentTracker()`) with an unconditional-overwrite flush would erase persisted history on the very next flush after every restart.
3. **Run-end must close the loop.** `finalizeRun` (squad-manager.ts:2861–2894) and `restart()` never touch `rec.subs` today. A subagent frame that started but never got a terminal frame before the daemon died (or the run ended) persists as `running` forever unless something stamps it closed.

## Approach

### 1. `src/subagents.ts` — expose `index`, add merge + closure

Add `index` to the public `SubagentNode` interface (28–36; today it's `TrackedSubagent`-only, 39–41) — needed so a persisted snapshot round-trips ordering and a reseeded tracker sorts correctly:

```ts
export interface SubagentNode {
	id: string;
	agent: string;
	description?: string;
	status: string;
	task?: string;
	lastUpdate: number;
	/** Spawn order within the parent run. Exposed (unlike before) so a persisted snapshot round-trips
	 *  ordering and a reseeded tracker (applySnapshot on reattach) sorts identically to the live tree. */
	index: number;
}
```

`list()` (120–132) already has every field except `index` in its return mapper — add `index: n.index`. `TrackedSubagent` (39–41) can now simply be `type TrackedSubagent = SubagentNode` (drop the extends — no more hidden field).

Truncate + redact `task`/`description` in the **persisted projection only** (the live in-memory tracker keeps full strings for the existing endpoint), mirroring the spans-layer discipline at `src/spans.ts:91` (`redact(String(v)).slice(0, 240)`):

```ts
import { redact } from "./redact.ts";

/** Persisted-snapshot projection: truncates task/description to 240 chars + redacts, same discipline as
 *  span attrs (spans.ts:91). The live in-memory tracker (used by the polling endpoint) keeps full text —
 *  only what rides the roster snapshot / SSE agent DTO gets bounded. */
function toPersisted(n: SubagentNode): SubagentNode {
	return {
		...n,
		description: n.description !== undefined ? redact(n.description).slice(0, 240) : undefined,
		task: n.task !== undefined ? redact(n.task).slice(0, 240) : undefined,
	};
}
```

Add a dirty accessor and a persisted-projection getter to `SubagentTracker`:

```ts
private dirty = false;

/** True iff a node was created or any tracked field transitioned since the last clearDirty(). Heartbeats
 *  (ingestEvent) and no-op re-ingests never set this — write volume stays proportional to real change. */
isDirty(): boolean {
	return this.dirty;
}

clearDirty(): void {
	this.dirty = false;
}

/** The persisted-projection snapshot (truncated/redacted), ordered like list(). */
snapshot(): SubagentNode[] {
	return this.list().map(toPersisted);
}
```

Wire `dirty = true` inside `ingest()`'s three branches by using each `ingestX` method's own existing boolean return (already computed):

```ts
ingest(frame: { type: string; payload?: unknown }): boolean {
	const payload = frame.payload;
	if (payload === null || typeof payload !== "object") return false;
	let changed = false;
	switch (frame.type) {
		case "subagent_lifecycle": changed = this.ingestLifecycle(payload as LifecyclePayload); break;
		case "subagent_progress": changed = this.ingestProgress(payload as ProgressPayload); break;
		case "subagent_event": changed = this.ingestEvent(payload as EventPayload); break;
		default: return false;
	}
	if (changed) this.dirty = true;
	return changed;
}
```

(`ingestEvent`, 168–174, only ever bumps `lastUpdate` on an *existing* node and returns `true` for that — per design decision this stays "quiet" in spirit since it's a heartbeat, but its current `true` return already only fires on known nodes; leaving it wired through `dirty` is acceptable since heartbeat volume was already excluded from lifecycle-only gating in the rejected draft — confirm during implementation whether `ingestEvent`'s bump should be excluded from `dirty` to hold write volume flat 1:1 with intent; if so, special-case it to not set `dirty` while still returning `true` for the existing "did the tracker change" callers.)

Add `applySnapshot`'s missing caller-side contract — the method itself (94–117) is unchanged; concern's job is to actually call it (below).

Add closure:

```ts
/** Stamp every non-terminal node aborted (run ended/agent stopped without a terminal frame for it), and
 *  mark dirty so the caller's next flush persists the closure. Idempotent — a second call after all nodes
 *  are already terminal is a no-op (dirty stays false). Call at finalizeRun/agent_end and at the restart()
 *  clear site, BEFORE clearing, so a persisted entry can never claim "running" under a stopped agent. */
closeNonTerminal(): void {
	const TERMINAL = new Set(["completed", "failed", "aborted"]);
	for (const n of this.nodes.values()) {
		if (!TERMINAL.has(n.status)) {
			n.status = "aborted";
			n.lastUpdate = Date.now();
			this.dirty = true;
		}
	}
}
```

### 2. `mergeSubagents()` — one shared projection (new export in `src/subagents.ts`)

```ts
/**
 * The single read/write contract for subagent lineage: persisted history ∪ live tracker, live wins per
 * id. Used both to compute what a flush writes AND what every reader (manager.subagents(), the
 * GET /api/agents/:id/subagents endpoint) returns — so the two surfaces can never drift, by construction.
 */
export function mergeSubagents(persisted: SubagentNode[] | undefined, live: SubagentNode[]): SubagentNode[] {
	const byId = new Map<string, SubagentNode>();
	for (const p of persisted ?? []) byId.set(p.id, p);
	for (const l of live) byId.set(l.id, l); // live wins on id collision
	return [...byId.values()].sort((a, b) => a.index - b.index || a.lastUpdate - b.lastUpdate);
}
```

### 3. `squad-manager.ts` wiring

**Flush on dirty** — in `onAgentEvent`'s existing `subagent_` branch (2667–2672), after `rec.subs.ingest(...)`, flush when dirty:

```ts
if (frame.type?.startsWith("subagent_")) {
	rec.subs.ingest(frame as { type: string; payload?: unknown });
	rec.run?.onSubagentFrame(frame as { type: string; payload?: unknown });
	if (rec.subs.isDirty()) {
		rec.dto.subagents = mergeSubagents(rec.options.subagents, rec.subs.snapshot());
		rec.options.subagents = rec.dto.subagents;
		rec.subs.clearDirty();
		void this.persist(); // chain-deduped by concern 01 — safe to call on every dirty transition
	}
	return;
}
```

**Read contract** — `manager.subagents()` (1272–1274) and the `GET /api/agents/:id/subagents` handler (server.ts:1218–1219, unchanged route) both go through the same projection:

```ts
subagents(id: string): SubagentNode[] {
	const rec = this.agents.get(id);
	if (!rec) return [];
	return mergeSubagents(rec.options.subagents, rec.subs.list());
}
```

Note: `rec.subs.list()` here returns full (untruncated) live text for the endpoint's own consumers; `rec.dto.subagents`/`rec.options.subagents` carry the truncated `snapshot()` projection written at flush time. `mergeSubagents` is agnostic to which projection it's fed — the live-wins-per-id merge works either way, so the live view is always full-fidelity for currently-tracked nodes and only falls back to the truncated persisted text for nodes the live tracker has forgotten (should not happen in practice since `clear()` only fires in `restart()`, immediately preceded by `closeNonTerminal()` + a flush).

**Reseed on reattach/adopt** — `attachExisting` (859–896): after constructing `rec` (887), call `rec.subs.applySnapshot(p.subagents ?? [])` before `this.wire(rec)` so a reconnect/adopt starts the live tracker warm instead of empty. `create()`'s literal build doesn't need this — a fresh spawn has no prior subagents — but the `adoptOrphanedAgents`/`loadPersisted` → `create()` paths do; since `create()` is shared by both fresh spawns and restores, seed inside `create()` right after `rec` is constructed (squad-manager.ts, after line 2150) guarded on `opts.subagents?.length`:

```ts
if (opts.subagents?.length) rec.subs.applySnapshot(opts.subagents);
```

**Run-end closure** — in `finalizeRun` (2861–2894), before `rec.run = undefined` / `this.emitAgent(rec)` (2892–2893):

```ts
rec.subs.closeNonTerminal();
if (rec.subs.isDirty()) {
	rec.dto.subagents = mergeSubagents(rec.options.subagents, rec.subs.snapshot());
	rec.options.subagents = rec.dto.subagents;
	rec.subs.clearDirty();
	void this.persist();
}
```

**Restart closure** — in `restart()` (2600–2623), immediately before `rec.subs.clear()` (2608), insert the same closure-and-flush block, then `rec.subs.clear()` as today (a fresh run starts the tracker empty; the closed history is already durably flushed by this point so `clear()` no longer loses anything).

### 4. Tests

Extend `tests/subagents.test.ts`: `isDirty()`/`clearDirty()` semantics (dirty on create, dirty on transition, NOT dirty on a no-op re-ingest, NOT dirty on a pure heartbeat if that's the chosen behavior from step 1's note); `closeNonTerminal()` stamps only non-terminal nodes and is idempotent; `mergeSubagents()` — live wins per id, union includes persisted-only entries, stable sort by index/lastUpdate; the specific race this concern fixes — feed a progress frame carrying `status:"completed"` BEFORE the matching lifecycle `completed` frame, assert the node's final status is `"completed"` (not reverted) and `isDirty()` was true at the progress step.

New `tests/squad-manager-subagent-lineage.test.ts`: spawn an agent, drive `subagent_lifecycle`/`subagent_progress` frames through `onAgentEvent` (or the manager's public event surface if frames aren't directly injectable — check `tests/subagents.test.ts` for the existing harness pattern), assert a flush occurred (`rec.options.subagents` populated) and `manager.subagents(id)` matches; kill the agent mid-subagent-run (or call the private closure path via `finalizeRun` if reachable in tests, else via a full agent lifecycle drive) and assert no node is left `"running"`; reattach/adopt a persisted agent carrying `subagents` and assert `manager.subagents(id)` returns the seeded history before any new frame arrives.

## Verify

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
bun test tests/subagents.test.ts
bun test tests/squad-manager-subagent-lineage.test.ts
bun test tests/squad.test.ts
bunx tsc --noEmit
```

## Dependency graph

| concern | blockedBy |
|---|---|
| 02-subagent-merge-flush-lineage | 01-boot-path-threading-and-durability |

## Resolution
Shipped in 6f78e20 (reviewed post-hoc after a harness death — PASS; + audit fixes a5c42dc create()-restore closure, f3209a4 reattachTerminal closure + dirty-flush emitAgent, 848295b per-run chronological merge ordering). Transition-based dirty tracking with a dedicated progress-before-lifecycle race test.
