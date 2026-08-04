# BoundarySyncLane — the turn-boundary wiring leaves squad-manager
STATUS: open
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
