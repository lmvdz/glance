# Joined task-outcome row + idempotent agentId key
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts (land() ~:2320-2337, reconciler ~:4570-4572, finalizeRun ~:4670-4685), src/types.ts (PersistedAgent.routing), new src/task-outcomes.ts
BLOCKED_BY: 01-effective-model-capture, 02-create-anchored-denominator
VERIFY_BLOCKER: `grep -n "model" src/receipts.ts` shows late-bind from C01; `isLandingUnit` from C02 is importable

## Goal
Produce one trustworthy, idempotent row per unit that joins the routing decision (what we picked) with the real terminal outcome (what happened), so the matrix (C05) reads a small pre-joined log instead of re-deriving a fragile cross-file join on every request.

## Approach
1. **Persist the routing decision.** `routeIntake`'s decision is currently only logged (`squad-manager.ts:3007`). Stamp it onto `PersistedAgent.routing = { mode: verifyMode ?? "none", tier: tierOf(thinking), thinking, routedAt }` at the point it resolves (`:2996-3008`). This is the durable "what we picked" record, inspectable and surviving restart.

2. **New append log `src/task-outcomes.ts`** with `recordTaskOutcome(stateDir, row)` and `readTaskOutcomes(stateDir)`. Row shape (keep it small — see idempotency + concurrency below):
   `{ agentId, branch?, routing:{mode,tier}, model, costUsd?, confidence?, validation?, outcome: "landed"|"rejected"|"abandoned", source: "land"|"reconciled"|"sweep", ts }`.
   Model/cost/confidence/validation come from the unit's finalized receipt (C01 makes `model` real); `outcome`/`branch` come from the land event.

3. **Write at `land()` (`:2320-2337`).** `land()` already has the live agent (routing + last receipt) and the `ok` boolean in one place — write the row there, on **every non-retryable terminal land attempt** (ok and not-ok), so operator-driven and conflict failures are captured rather than dropped by the existing `if(!result.retryable && (auto||result.ok))` guard. (Staged/retryable holds are still accounted for as failures via C02's roster denominator; they just don't get a detailed row.)

4. **Idempotent on `agentId`, indexed by branch.** Upsert semantics, last-terminal-wins, so re-entry (revert→reland, reconciler double-fire) is safe and never double-counts. Because `land()`/`recordLandOutcome` (`:2331-2332`) and the reconciler backstop (`:4570-4572`, `agentByBranch` often undefined) are **branch**-keyed, maintain a `branch→agentId` index derived from the roster so all three paths resolve to the same row. On the reconciler out-of-band path where the agent is gone, resolve agentId via the index (or scan receipts by branch as a last resort), tag `source:"reconciled"`; if unresolvable, log-and-skip rather than fabricate.

5. **Concurrency:** keep rows small (no spans/rationale) so `O_APPEND` writes stay under PIPE_BUF and don't interleave; single-daemon event loop serializes appends, but a multi-daemon/restart overlap is possible — small rows + agentId-keyed upsert-on-read make an interleave recoverable.

## Cross-Repo Side Effects
`PersistedAgent` gains an optional `routing` field (additive, `src/types.ts`). No consumer breaks.

## Verify
- Land a unit; confirm exactly one row in `task-outcomes.jsonl` keyed by its agentId, with a real `model` (C01), `routing`, and `outcome:"landed"`.
- Force a failed manual land; confirm a `rejected` row is written (not dropped by the guard).
- Trigger the reconciler out-of-band path (merge a squad branch directly, let the reconciler catch it); confirm it resolves to the same agentId row via the branch index and does not create a duplicate.
- Revert→reland the same branch; confirm the row updates (terminal-wins), not doubles.

## Resolution
Closed — commits `ce49f1b` + review fix. New `src/task-outcomes.ts` (`recordTaskOutcome` durable append, `readTaskOutcomes` collapse-by-agentId terminal-wins); `PersistedAgent.routing?` (additive); `land()` writes the row under a deliberately wider `!result.retryable` gate so manual (auto:false) failures record a `rejected` row (the narrower sibling `(auto||result.ok)` guard drops them); reconciler resolves agentId via `resolveAgentIdForBranch` (roster → receipt scan). Opus review confirmed the land() placement is correct (staged holds return earlier → no row; PR-mode only reports `landed` on real merge) and the terminal-wins collapse is sound (single shared file → append order is chronological). **Review fix applied:** `resolveAgentIdForBranch` picked "most recent" by `readAllReceipts` iteration order, which is filesystem `readdir` order (per-agent files), NOT chronological — on a reused branch it could misattribute a reconciled outcome to a stale agent. Fixed to select max by `endedAt ?? startedAt`. Full suite 1561/1561; tsc clean. Known-minor: a no-op land (ok:true, nothing merged) writes a `landed` row — consistent with the existing `recordModelOutcome` ledger, not a C03-introduced inconsistency. Test gap (accepted): no direct test of `resolveAgentIdForBranch` branch-reuse ordering (private reconciler helper; would need a heavy integration harness) — the fix is tsc-checked + logically simple (max-by-time).
