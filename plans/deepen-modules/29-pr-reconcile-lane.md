# PrReconcileLane — the loosest-coupled big region left
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/squad-manager.ts 9667–10150 (prReconcileTick → reconcileOnePr (135 lines) → attemptCloseFor; repoPathForIdentity/agentByBranch/resolveAgentIdForBranch; heal paths retryPushFloat + ffHealOne)
MODE: afk

## Goal
485 lines, 13 methods, only 21 distinct `this.` fields — the best size:coupling ratio in the
manager after the probe family. Coherent single concern (reconcile open PRs against fleet
state, close landed issues, heal push/ff drift). Extract `PrReconcileLane` behind
`{ agents(), repoPath(), closeLandedIssue(), log() }` following the BoundarySyncLane template:
lane class + closure deps port, tick stays scheduled manager-side, interleavings become
table-testable.

## Provenance
Round-3 review, daemon agent, ranked 2.
