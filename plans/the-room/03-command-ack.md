# Command ack/nack — no silently dropped steers (supersedes buzz-borrows 04)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts (applyCommand), src/types.ts (SquadEvent), src/server.ts (WS path), webapp/src/lib/agent-control.ts, webapp/src/lib/dto.ts, tests
MODE: afk

## Goal
A steer/prompt whose target is missing, denied, or deduped produces an observable signal. Today it
vanishes: `if (!rec) return;` (src/squad-manager.ts:7019-7020); WS callers get no per-command
response. Prerequisite for mention UX (concern 10).

## Approach
1. SquadEvent arm `{type:"command-ack", clientTurnId, ok, reason?}` (additive to the union at
   src/types.ts:1471-1483), delivered via per-org broadcastTo. Nack reasons: missing-target,
   denied, duplicate, spawn-failed. Ack on driver acceptance (after ensureConnected/prompt
   resolves), not on receipt.
2. NOT daemon-only (A-S2): steerCommand deliberately omits clientTurnId today
   (webapp/src/lib/agent-control.ts:131-139) — REVERSE that documented decision: steer (and the
   mention path) mints a fresh clientTurnId. Update the comment to record why.
3. Dedupe scope must accommodate requestId-valued clientTurnIds from answerCommand
   (agent-control.ts:127-129; daemon echo at src/squad-manager.ts:7061 is the only consumer —
   verified) — dedupe keys on (clientTurnId, command type) or excludes answer.
4. Missing-id path nacks instead of bare return; RBAC denial (commandTier) nacks `denied`;
   duplicate clientTurnId within a short window nacks `duplicate`.
5. Webapp: optimistic-pending reconcile on ack; existing optimistic-turn logic unbroken.

## Cross-Repo Side Effects
None.

## Verify
- WS prompt to nonexistent id → command-ack {ok:false, reason:"missing-target"}.
- Duplicate rapid same-clientTurnId → second nacks duplicate. Legit steer → ack after driver accept.
- Answer path (clientTurnId = requestId) unbroken; Composer tests green.
