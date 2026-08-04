# UnitCardProjector — the manager's hand-rolled projection half
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/squad-manager.ts 12436–12882 (446 lines, 17 private methods, 4 entry points), src/voice-call-projection.ts (the module-shaped twin)
MODE: afk

## Goal
CallProjectionStore already proves the shape for voice events; the unit-event equivalent is
hand-rolled inside the manager. Extract behind 5 methods (event/needsYou/lifecycle/
validationVerdict/label). DECIDE FIRST: ensureProjectedNode has 5 callers outside the region
(3942, 3968, 3986, 5068, 7268) — node-binding moves with it or stays a shared helper. Follow-up
unlocked: one shared card-emit primitive under both projectors. Pairs with the landed
transcript-event-kinds module (PR #317).

## Provenance
Round-2 review, daemon agent, rank 4, Worth exploring.
