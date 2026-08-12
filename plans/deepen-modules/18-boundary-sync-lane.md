# BoundarySyncLane — the turn-boundary wiring leaves squad-manager
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/squad-manager.ts 6111–6570 + 2834–2866 (459 lines / 12 distinct this.* refs), src/boundary-sync.ts (decision core, already extracted), 2 manager fields + 3 AgentRecord fields
MODE: afk

## Goal
The best size:coupling island left in the god class, and its own header comment declares the
seam ("the decision core lives in boundary-sync.ts; this block is the turn-boundary wiring").
Extract BoundarySyncLane with a 6-closure port (log, agents.get, recordAudit, friction,
raise/clear via concern 19's lane); manager keeps 7 one-line delegators. HAZARD: the dual-key
queueBoundarySync chain (6119–6135) moves VERBATIM; the fail-closed N2/N3/N4/M1/C1/S5
annotations survive a mechanical move only. Deletion test: here-sessions stop syncing patches;
nothing else notices.

## Provenance
Round-2 review (plans/deepen-modules/review-round-2.html), daemon agent, rank 1, Strong.

## Done (2026-08-11, round 3 iteration 2)
Extracted exactly as designed: BoundarySyncLane (src/boundary-sync-lane.ts, ~600 lines with the
verbatim fail-closed annotations) behind a 5-closure deps port (log, agent-by-id, emit,
recordAudit, friction) + the structural BoundarySyncSession slice; manager keeps 4 public
delegators + 2 event-boundary lane calls; the dual-key queueBoundarySync chain moved verbatim.
Codex clean-checked the move (normalized bodies identical, lane singleton per manager incl.
DB/multi-org, boot ordering intact) and caught the one real defect: the wiring test harness
bracket-accessed the deleted private methods — 20/22 tests TypeError'd at RUNTIME (the untyped
test corpus, concern 23's exact blind spot, live again). Grok: narration-only exit x3, coverage
gap ledgered. Gates: check 0, boundary pair 89/89, root 5332 pass with only the two ratchet
reds INHERITED from main (error-idiom 89/88 = rail's unpaid hit; dead-exports 211/210 = the
broken raw-scan's position sensitivity — this branch adds zero exported functions) — both
already fixed properly on PR #370.
