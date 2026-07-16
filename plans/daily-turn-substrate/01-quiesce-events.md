# Quiesce events — typed fail-closed completion signal

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/quiesce.ts (new), src/squad-manager.ts (agent_end case ~:6243, EventEmitter base :747), src/server.ts (SquadEvent WS broadcast), src/types.ts (SquadEvent union :1321), src/workflow/executor.ts (IDLE_POLL_MS/IDLE_TICKS loop :106/:132/:364-397), src/dispatch.ts (Dispatcher :161), src/autoland.ts, src/land.ts, src/acp-agent-driver.ts:500 (agent_end emit, read-only reference), src/workflow-driver.ts:491 (agent_end emit, read-only reference), scripts/defect-ratchet.ts (new pattern entry), tests/ (new)

## Goal

Give internal awaits and external consumers a typed completion signal — `QuiesceEvent {kind, correlationId, outcome, at}` for kinds `turn.quiesced`, `checkpoint.captured`, `diff.finalized`, `transition.settled` — with an `awaitQuiesce(kind, correlationId, timeoutMs)` that returns `{outcome:"settled"|"timeout"}` and NEVER throws-and-swallows. First consumer: replace src/workflow/executor.ts's poll-and-guess `isStreaming` idle loop (IDLE_POLL_MS=5000, IDLE_TICKS=6, ~30s inferred timeout at :364-397) with an honest typed wait.

## Approach

- New `src/quiesce.ts`: a dedicated quiesce bus (separate EventEmitter instance held by SquadManager, not reusing the giant SquadEvent contract directly for internal awaits — bridges OUT to it only for the WS discriminant) plus `awaitQuiesce`.
- **Timeout ≠ settled (fail-closed, non-negotiable):** `awaitQuiesce` resolving `{outcome:"timeout"}` must never be treated as `{outcome:"settled"}` by any caller. Every timeout path degrades to one of: (a) re-derive the real state from persisted data (transitions.jsonl, WorkflowRunState, checkpoint-log) instead of assuming completion, or (b) raise an AttentionEvent (src/types.ts:111, non-blocking) so a human sees the stall. Add a `scripts/defect-ratchet.ts` pattern (committed-baseline convention, `baseline: 0` per its documented rule for new patterns) that flags any `awaitQuiesce(...)` call site whose result isn't destructured/branched on `.outcome` in the surrounding statements — a discarded outcome is the exact defect class this concern exists to prevent.
- **Lost-wakeup guard:** events can fire before a caller subscribes (the emitting side doesn't know who's listening yet). Keep a short-lived completed-event buffer (map keyed by `${kind}:${correlationId}` → outcome, TTL-bounded) that `awaitQuiesce` checks FIRST, before attaching a listener+timeout race. A caller that calls `awaitQuiesce` after the event already fired must still resolve `settled`, not `timeout`.
- **CorrelationId minting:** random (`crypto.randomUUID()` or equivalent), minted once at job creation time — never derived from an in-memory counter, array length, or anything not itself durably persisted. A restart must not risk two different jobs colliding on the same id.
- **Dedupe vs. agent-host ring replay:** pendings rebuilt during the post-reattach settle window are tagged `replayed: true` (confirmed live at squad-manager.ts:7879-7881, in the tool-call pending-add path). Quiesce consumers must recognize replayed-tagged completions and not re-fire (or re-await) a quiesce event for a correlationId that already resolved before the restart — otherwise a reattach replay would double-signal settlement for a turn that already quiesced.
- **Emit points:** SquadManager owns the emit calls (drivers already emit real `agent_end` — acp-agent-driver.ts:500, workflow-driver.ts:491 — SquadManager's `onAgentEvent` `agent_end` case, squad-manager.ts:6243 region, is where the manager already re-derives `voicePushArmed` per turn; add the `turn.quiesced` emit there, since only the manager knows the turn's correlationId). `checkpoint.captured` emits from concern 02's capture point. `diff.finalized` and dispatch/land settle points emit from src/dispatch.ts's `Dispatcher` (:161), src/autoland.ts (`autoLandOnSuccess`), and src/land.ts (`landAgent`) at their existing resolution points — additive calls alongside existing logic, no control-flow changes at emit sites.
- **Transport:** in-process quiesce bus for internal `awaitQuiesce` callers; add a new `{type:"quiesce", event: QuiesceEvent}` discriminant to the `SquadEvent` union (src/types.ts:1321) broadcast the same way every other SquadEvent already reaches `ws.send` in src/server.ts — additive, existing consumers ignore unknown discriminants.
- **First consumer:** src/workflow/executor.ts's idle-check loop (:364-397) replaces its `isStreaming`-poll-then-guess-after-IDLE_TICKS heuristic with `awaitQuiesce("turn.quiesced", correlationId, timeoutMs)`. On `{outcome:"timeout"}` the executor must NOT assume `agent_end` happened — it re-derives from persisted `WorkflowRunState`/transitions or raises attention, replacing an inferred guess with an honest typed non-settlement.

## Cross-Repo Side Effects

none — omp-squad only; the SquadEvent WS payload gains an additive discriminant that unknown consumers safely ignore.

## Verify

All four constraints below must be exercised as `bun test` cases under tests/, alongside a ratchet entry that runs under the same suite invocation (no `.github/workflows` exist in this repo; `bun test` is the gate):

- (a) **No caller may treat timeout as settled.** Behavioral test: drive a timeout path (short `timeoutMs`, no matching emit) and assert the caller's fallback (re-derive from persisted state / raise attention) actually executes — not a silent continue. Plus the ratchet/lint entry (baseline 0) flagging any `awaitQuiesce` call whose `.outcome` is discarded.
- (b) **Completed-event buffer checked before subscribe.** Test: emit the quiesce event for `(kind, correlationId)` BEFORE calling `awaitQuiesce` for that same pair; assert it resolves `settled`, not `timeout` — proving the buffer is consulted first, closing the lost-wakeup race.
- (c) **Random correlationIds, never counter-derived.** Test: mint two correlationIds for two jobs created in the same tick; assert they are never equal and assert no relationship to any counter/array-length value (mint via `crypto.randomUUID()` or equivalent, not a sequence).
- (d) **Dedupe vs. agent-host ring replay.** Test: simulate a reattach where a pending is rebuilt with `replayed: true` (squad-manager.ts:7879-7881 shape) for a correlationId that already resolved pre-restart; assert no duplicate quiesce event fires for it.
