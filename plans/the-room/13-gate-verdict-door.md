# Gate-verdict door — GateVerdictCard + historical proof mode
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/hub/GateVerdictCard.tsx (new), src/server.ts (historical proof endpoint), src/done-proof.ts + src/land-assessment/store-reader.ts (reads), webapp router, tests
BLOCKED_BY: 04, 05, 08
MODE: afk

## Goal
Validator verdicts (ValidationRecord) render as proof cards whose faces carry the pinned verdict/
agreement/confidence/per-criterion material, and whose door works FOREVER: for a resident unit it
opens the live programmer view; for a departed unit it opens a post-mortem mode — "unit landed —
here's the proof record" — from persisted records. A gate verdict matters most exactly when the
unit is gone (A-C3/S6, B-F4); this door must never dead-end.

## Approach
1. New GateVerdictCard — NOT GateWidget (that is a live answer form binding PendingRequest,
   webapp/src/components/chat/GateWidget.tsx:7-13; rendering it in a shared channel would offer
   every member an answer box into someone's agent).
2. Historical proof endpoint: disk-backed read over EXISTING persisted records only — done-proof
   (src/done-proof.ts:16-27), land-assessment store snapshots/events, the pinned ValidationRecord
   from the card payload. No new record types minted (scope guard from design risks).
3. Door logic: resident → live route (concern 12's); gone → post-mortem route rendering proof
   material + land outcome + branch/sha. Test BOTH against a landed-and-removed unit (B-F4's
   test requirement), including DB-mode manager-evicted (manager-registry idle eviction).
4. Face renders instantly from pinned payload; endpoint fetch is the door only.

## Cross-Repo Side Effects
None.

## Verify
- Land a unit in scratch daemon, let it be removed → verdict card still renders; click → post-
  mortem with verdict + done-proof + sha; resident unit → live view. Door-open latency measured
  and recorded on the PR (design risk gate).

## Resolution
Landed in train wave3: GateVerdictCard, gateVerdictProof endpoint (read-only over existing stores), resident/post-mortem modes, tested against landed-and-removed units.
