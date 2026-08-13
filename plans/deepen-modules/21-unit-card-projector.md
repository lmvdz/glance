# UnitCardProjector — the manager's hand-rolled projection half
STATUS: done
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

## Done (2026-08-12, PR #381 — round 3 iteration 15)
`src/unit-card-projector.ts` (363 lines): `UnitCardProjector` owns the projectUnitTranscriptEvent
funnel (`event()`), needsYouFace, face/doorSurface/payload/refs derivation, and the needs-you
emit/resolve replay-suppression discipline, behind `UnitCardProjectorDeps` — the DECIDE-FIRST
question resolved as "stays a shared helper": `ensureProjectedNode` (5 external callers) and
`emitUnitTranscriptEvent` (9+) remain manager-side closures; the manager sheds ~230 lines.
`ProjectedUnitSession` is the structural slice (`dto` + `options.{channelId, task}`) and
`ensureProjectedNode` now takes it (cast removed). Review round earned its keep: codex split
`roomWorthy` back out of `gateClassOf` (documented as different questions; plans/the-room/26
widens one but not the other), grok delivered a 9-method byte-parity PASS table converging on
the same coupling note, and the full root suite caught tests/voice-ratchet.test.ts scanning
only squad-manager.ts for emitted strings — the moved needs-you copy made its blast-radius
test find zero strings (run-the-callers, again). Scanner reads both files now. The follow-up
(one shared card-emit primitive under both projectors) stays a review-round candidate.
