# Durable pending + cold-adopt orphan-close + ghost expiry

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/dal/store.ts, tests/durable-pending.test.ts (new), tests/pending-ghost-expiry.test.ts (new)

## Goal

`pending[]` becomes real durable state: a debounced persist actually writes it (today nothing does — the `PersistedAgent.pending` field, once added, would otherwise stay perpetually stale or resurrect an already-answered question, which both red-team rounds independently proved). Cold-adopted agents never carry an unanswerable "restored" pending — the persisted question is consumed once, at adoption, only to record that it was orphaned. Warm reattach relies entirely on the agent-host's own ring replay (which already rebuilds live, answerable pendings) — this concern's only job on the warm path is closing the two ways a replayed pending can become a permanent ghost that wedges `applyState`'s reconciliation.

## Approach

### 1. `PersistedAgent.pending` (src/types.ts)

Add to `PersistedAgent` (src/types.ts:574+, alongside the other fields already listed there):

```ts
/** Snapshot of in-flight human-input requests at persist time. Advisory only — see squad-manager.ts's
 *  cold-adopt path, which consumes this ONLY to record a pending-orphaned close, never to re-populate
 *  dto.pending. A cold-adopted agent's correlation id is dead (the RPC waiter died with the old process),
 *  so nothing restored here can ever be legitimately answered — do not build an "answerable restore" path. */
pending?: PendingRequest[];
```

`DbStore` needs no schema change (the roster row is a JSON blob — this rides for free, per the design's "rides DbStore's JSON blob for free" note). `FileStore` needs no migration — every read site does `p.pending ?? []`, so an old `state.json` without the field just yields an empty array, matching today's behavior exactly.

### 2. Debounced persist trigger (src/squad-manager.ts)

`persistNow()` (squad-manager.ts:3531-3542) already needs one addition — fold `pending` into the options snapshot:

```ts
private async persistNow(): Promise<void> {
	const live = [...this.agents.values()].map((r) => ({ ...r.options, pending: r.dto.pending }));
	// ... rest unchanged (deferred fold-in, transcripts, features, store.save)
}
```

The real fix is that **something must actually call persist() when pending changes** — today nothing does, which both red-team rounds independently proved makes the naive "just widen the snapshot shape" version of this concern a no-op. Add a debounced trigger inside `setPending()` (the guarded method from concern 01):

```ts
private pendingPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

private setPending(rec: AgentRecord, next: PendingRequest[], reason: DerivedReason, cause?: Record<string, unknown>, opts?: { status?: AgentStatus }): void {
	rec.dto.pending = next;
	// ... existing transition-derivation logic from concern 01 ...
	if (!this.settling.has(rec.dto.id)) this.schedulePendingPersist(rec.dto.id); // suppressed during replay settle (§4)
}

private schedulePendingPersist(agentId: string): void {
	const existing = this.pendingPersistTimers.get(agentId);
	if (existing) clearTimeout(existing);
	this.pendingPersistTimers.set(agentId, setTimeout(() => {
		this.pendingPersistTimers.delete(agentId);
		void this.persist(); // full-roster persist through the existing serialized atomic writer (writeChain, squad-manager.ts:3514-3528)
	}, 1000));
}
```

A full-roster `persist()` (not a per-agent write) is correct here — `persistNow()` already serializes every agent's full transcript on every call (verified at squad-manager.ts:3538-3541: `for (const r of this.agents.values()) if (r.transcript.length) transcripts[r.dto.id] = r.transcript;`), so per-mutation full persists would be too heavy, but a single debounced persist ~1s after the last pending mutation coalesces bursts (e.g. `pending-add` immediately followed by `pending-answer` when auto-supervise fires) into one write. The ≤1s crash window is documented best-effort, strictly better than today's never-persisted baseline. `stop()` must still flush: confirm the graceful shutdown path already `await`s `this.persist()` as a durability barrier (it does, per the design note "graceful stop() already awaits the chain") — add an explicit `for (const t of this.pendingPersistTimers.values()) clearTimeout(t); await this.persist();` at the top of `stop()` so a graceful shutdown never loses the debounce window's pending mutation (only an actual crash can).

### 3. Cold-adopt orphan-close (src/squad-manager.ts, inside `adoptOrphanedAgents`)

`adoptOrphanedAgents` (squad-manager.ts:787-845) calls `this.create({...}).then(() => { n++ })` per adoptable persisted record (line 809-841) — `create()` mints a **fresh** agent id (verified: `create()` generates its own id internally, `p.id` from the persisted record is never passed through). This is why the design deletes the draft's "restored:true kept-in-queue" approach entirely: a restored pending pinned to the fresh record would permanently pin `derive()` at `"input"` (squad-manager.ts:3241, `if (rec.dto.pending.length > 0) return "input"`) since nothing can ever answer it (the RPC waiter that would resolve it died with the old process — `respondUi` on a dead correlation id is fire-and-forget into nothing, per `rpc-agent.ts:379,286-293`).

Do this instead, inside the `adopt` loop, after each `create()` resolves:

```ts
for (const p of adopt) {
	await this.create({ /* ...unchanged CreateAgentOptions... */ })
		.then((dto) => {
			n++;
			if (p.pending?.length) this.closeOrphanedPending(dto.id, p);
		})
		.catch((err) => this.log("warn", `take over ${p.name} failed: ${String(err)}`));
}
```

```ts
/** A cold-adopted agent's persisted pending can never be legitimately answered (fresh id, dead RPC
 *  correlation) — record its closure so the operator sees "this agent was waiting on you before the
 *  crash" without a permanently-unanswerable entry in dto.pending. If the resumed workflow's checkpoint
 *  shows the same gate will re-ask (GATE_FOLD_VAR still unset at this node), mark it reask-expected so
 *  the operator isn't alarmed by what's actually a normal re-prompt. */
private closeOrphanedPending(newAgentId: string, persisted: PendingAgent /* PersistedAgent */): void {
	const rec = this.agents.get(newAgentId);
	if (!rec) return;
	const reaskExpected = persisted.kind === "workflow" && persisted.workflowState !== undefined && this.gateWillReask(persisted.workflowState);
	for (const p of persisted.pending ?? []) {
		this.transition(rec, rec.dto.status, "pending-cancel", {
			priorId: persisted.id,
			question: redact(p.title + (p.message ? `: ${p.message}` : "")),
			reaskExpected,
		});
		this.append(rec, "system", `⛔ prior question orphaned by adoption${reaskExpected ? " (workflow will re-ask)" : ""}: ${redact(p.title)}`, { pending: { requestId: p.id, action: "cancelled" } });
	}
}
```

Note this records a `"pending-orphaned"`-flavored event — reuse the `pending-cancel` `DerivedReason` from concern 01 with a `cause.priorId`/`cause.question` payload rather than inventing a new `TransitionReason` (keep the reason enum from concern 01 closed; the distinguishing information lives in `cause`, matching how `catastrophe` carries its detail in `cause.error` rather than a new reason per catastrophe flavor). `gateWillReask` is a small helper inspecting `workflowState` for whatever marker the workflow engine uses to know a gate node hasn't recorded an answer yet (grep `GATE_FOLD_VAR` usage in `src/workflow/engine.ts`/`src/workflow/types.ts` at implementation time — this concern only needs a read-only check, not a workflow-engine change).

Do **not** add `pending` to `CreateAgentOptions` (src/types.ts:642+) — `closeOrphanedPending` reads `p.pending` from the already-in-hand `PersistedAgent` record directly (it's already a parameter to the loop, no threading needed), keeping the public options type free of a one-shot bookkeeping field.

Symmetric case: `loadPersisted()` (squad-manager.ts:3545+) may also encounter records with stale `pending` when a plain (non-adopted) persisted agent is being restored outside the `adoptOrphanedAgents` path — audit `loadPersisted`'s call sites at implementation time; if any path there re-creates an agent from a `PersistedAgent` without going through `adoptOrphanedAgents`, apply the same `closeOrphanedPending` call there too so no code path can leak a stale pending into a fresh record.

### 4. Ghost expiry for replayed pendings (warm reattach path)

Warm reattach (`attachExisting`, concern 01's settle gate) never restores `dto.pending` from the snapshot — the agent-host's ring replay (`agent-host.ts:15,188`, up to 4000 frames) already re-emits `ui`/`hosttool` frames with live, answerable correlation ids, which `onUi`/`onHostTool` (squad-manager.ts:3124,3162) rebuild into `dto.pending` via `setPending` exactly as they would for a live request — no separate restore code path is needed or wanted (RT1/RT2 both independently proved a parallel snapshot-restore duplicates the question and risks staleness).

Tag pendings added **during the settle window** (concern 01's `this.settling.has(rec.dto.id)` check) with `replayed: true` on the `PendingRequest` itself (add the field to `PendingRequest` in `src/types.ts:32-47`):

```ts
export interface PendingRequest {
	// ...existing fields...
	/** Set when this request was (re)created from an agent-host ring replay during the post-reattach
	 *  settle window, not a fresh live request. Used ONLY by the two ghost-expiry rules below — never
	 *  gates answerability (a replayed pending IS answerable; the waiter lives in the surviving host). */
	replayed?: true;
}
```

`setPending`, when called from `onUi`/`onHostTool` while `this.settling.has(rec.dto.id)` is true, stamps `replayed: true` onto the new entries before storing them (this is a small addition inside `onUi`/`onHostTool`'s pending-construction, not inside `setPending` itself, since only those two call sites know a request just arrived from replay).

Two independent expiry rules, both required (either alone leaves a wedge case open):

**(a) Live post-settle turn boundary.** In `onAgentEvent`'s `"agent_end"` case (squad-manager.ts:2736+, after `rec.streaming = false`):

```ts
case "agent_end": {
	this.finishThinkingStream(rec);
	this.finishAssistantStream(rec);
	rec.streaming = false;
	rec.dto.activity = undefined;
	this.expireReplayedPending(rec); // NEW — a completed live turn proves any still-open replayed pending is stale
	// ...existing code (void this.finalizeRun(rec)) unchanged...
```

```ts
/** A blocking UI request suspends the agent's turn — so a turn that completed (agent_end fired) proves
 *  no live request is actually open. Any pending still tagged replayed:true is a ghost from the ring
 *  replay resurrecting an already-answered (pre-crash) question. Expire it, never silently. */
private expireReplayedPending(rec: AgentRecord): void {
	const ghosts = rec.dto.pending.filter((p) => p.replayed);
	if (!ghosts.length) return;
	this.setPending(rec, rec.dto.pending.filter((p) => !p.replayed), "pending-cancel");
	for (const g of ghosts) this.append(rec, "system", `⛔ stale question expired (answered before restart): ${redact(g.title)}`, { pending: { requestId: g.id, action: "cancelled" } });
}
```

**(b) Poll-based fallback.** In `applyState` (squad-manager.ts:3398-3424), track consecutive non-streaming polls per record (new field on `AgentRecord`, e.g. `nonStreamingPolls: number`, initialized to 0 alongside the record's other transient fields):

```ts
private applyState(rec: AgentRecord, state: RpcSessionState): void {
	// ...existing todo/context/model handling unchanged...
	if (rec.dto.pending.length === 0) {
		rec.streaming = state.isStreaming;
		if (rec.dto.status !== "stopped" && rec.dto.status !== "error") rec.dto.status = this.derive(rec);
	} else {
		// NEW: a pending queue holds a poll from resetting rec.streaming today (the existing guard above) —
		// piggyback the SAME poll cadence to count consecutive non-streaming ticks against ghosts specifically.
		if (!state.isStreaming) {
			rec.nonStreamingPolls = (rec.nonStreamingPolls ?? 0) + 1;
			if (rec.nonStreamingPolls >= 2) this.expireReplayedPending(rec);
		} else {
			rec.nonStreamingPolls = 0;
		}
	}
	this.emitAgent(rec);
}
```

This is the fallback for an agent that never fires another `agent_end` after reattach (e.g. it was already idle pre-crash with a stale replayed ghost and never gets prompted again) — two consecutive `isStreaming === false` polls is the signal `RpcSessionState` gives us that nothing is in flight. `expireReplayedPending` is idempotent (no-op if there are no `replayed:true` entries), so calling it from both (a) and (b) is safe.

**Known risk (carried from the design, not resolved here — test against it):** if `omp` ever reports `isStreaming === false` while genuinely suspended on a blocking UI request (rather than `true` while waiting), rule (b) could expire a real, live, un-replayed... no — rule (b) only ever touches `replayed:true` entries, so a live (non-replayed) pending is never at risk from either rule. The residual risk is narrower: a *replayed* pending that is actually still open (the operator hasn't answered it post-restart yet) could be prematurely expired if `isStreaming` behaves unexpectedly. Mitigation already built in: expiry is never silent (the `pending-cancel` transition + transcript note carry the question text), and the acceptance test below exercises a real `omp` blocked on a live confirm across a daemon restart before this rule is considered done.

## Cross-Repo Side Effects

None outside this repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/durable-pending.test.ts` — (1) add a pending via `setPending`, wait >1s, kill and reconstruct a `SquadManager` against the same `stateDir`, assert the persisted snapshot's `pending` matches; (2) two `pending-add`/`pending-answer` calls within the debounce window produce exactly one `persist()` call (spy on `store.save`); (3) `stop()` flushes an in-flight debounce timer synchronously (no ≤1s loss on graceful shutdown).
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/pending-ghost-expiry.test.ts` — (1) simulate `attachExisting` under settle with a scripted host replaying a `ui` frame; assert the resulting pending is tagged `replayed:true`; (2) fire a synthetic `agent_end` frame post-settle and assert the ghost is expired + a `pending-orphaned`-flavored transcript entry + transition record exist; (3) drive `applyState` with `isStreaming:false` twice in a row against a record holding only a `replayed:true` pending and assert expiry fires on the second poll, not the first; (4) assert a NON-replayed (live) pending is never touched by either rule regardless of poll count.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/adopt-cap.test.ts` (existing) — still green; extend or add a case asserting `adoptOrphanedAgents` on a persisted record with non-empty `pending` produces a fresh agent whose `dto.pending` is EMPTY (never restored) plus a recorded orphan-close transition.
- Manual acceptance test called out as a hard requirement by the design's risk log: run a live `omp` agent, drive it to a blocking `confirm`, restart the daemon mid-question, confirm (a) the operator still sees the question live and answerable post-restart (ring replay truth), and (b) it is never expired by the poll rule while genuinely still open.
- `bun run check`

## Dependency graph

blockedBy: 01-lifecycle-write-path.md
verifyBlocker: confirm the settle gate (`this.settling`) and `setPending()` exist — `grep -n "private readonly settling\|private setPending" src/squad-manager.ts` should return hits before starting. This concern does NOT depend on 02/03 and may land in parallel with them once 01 is merged.

## Resolution
Shipped in 0d5390f (+ audit fixes 8828721: persistNow filters replayed ghosts; poll-based ghost expiry env-gated behind OMP_SQUAD_PENDING_GHOST_EXPIRY default OFF pending the live blocked-confirm acceptance test — deterministic replay-tag expiry stays always-on). gateWillReask implemented against the parsed-graph human-node signal, not GATE_FOLD_VAR. Also narrowed concern 01's same-state early-return to turn-progress only.
