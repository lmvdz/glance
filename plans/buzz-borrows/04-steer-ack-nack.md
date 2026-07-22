# Steer ack/nack — no silently dropped commands
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts (applyCommand), src/server.ts (WS command path), src/types.ts (SquadEvent or ack shape), webapp/src/lib/dto.ts (type mirror only)
MODE: afk

## Goal
A steer/prompt command whose target is missing, denied by RBAC, or deduped produces a signal the sender can observe — today it vanishes (`const rec = this.agents.get(cmd.id); if (!rec) return;` at src/squad-manager.ts:7020, and WS callers fire `void ….catch(…)` with no per-command response channel per src/server.ts:1293). This is the daemon-side prerequisite for mention-as-dispatch (05) and kills a member of the stale-claims confusion class on its own.

## Approach
1. Commands already carry `clientTurnId` for optimistic-turn reconciliation — use it as both the dedupe key and the ack correlation id.
2. On `applyCommand` outcomes for prompt/steer-class commands: emit a small SquadEvent (e.g. `{type:"command-ack", clientTurnId, ok, reason?}` — additive arm to the 12-variant union at src/types.ts:1471, mirrored in dto.ts) via the existing `broadcastTo(orgId)` pipe. Nack reasons: `missing-target`, `denied`, `duplicate`, `spawn-failed`. Ack on driver acceptance (after `ensureConnected`/prompt resolves), not on receipt.
3. Missing-id path returns/naks instead of silent `return`; RBAC denial (commandTier, src/authz.ts:33) naks with `denied`; a duplicate `clientTurnId` within a short window naks `duplicate` — this is the "in-flight guard" the mention design needs, placed daemon-side so multi-tab is covered.
4. Webapp consumption of the ack event (toast/pending-state reconcile) is t3-face-lane rendering — out of scope here beyond the dto type mirror. The event flowing on the wire is UI-invisible until then.

## Cross-Repo Side Effects
None.

## Verify
- WS client sends prompt to a nonexistent id → receives `command-ack {ok:false, reason:"missing-target"}` (test via scratch daemon or existing WS test harness).
- Duplicate rapid submission with same clientTurnId → second gets `duplicate`.
- Legitimate steer → ack after driver accepts; existing optimistic-turn reconciliation unbroken (Composer tests still green).
