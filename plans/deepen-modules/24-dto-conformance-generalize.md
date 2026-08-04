# DTO conformance: 1 guarded pair → 42
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical, batched
TOUCHES: tests/dto-conformance.test-d.ts (machinery complete, in the gate, applied to ValidationRecordDTO only), 25 exact-name + 17 XDTO↔X mirror pairs
MODE: afk

## Goal
LIVE DRIFT FOUND: webapp SquadEvent (dto.ts 855–873) is missing the audit, automation, and
voice-call-participant variants entirely + fields on removed/log — unrepresentable, so no
exhaustiveness check could fire; useSquad switches on 13 of the daemon's 18 kinds. Extend the
existing file ~4 lines/pair; union types need one new variant-keyed helper. COMPLEMENTARY to
the blocked kernel re-exports (deliberate divergences like TransitionEntry.reason widening
need conformance-with-omit-list, never re-export). Land in batches by DTO family — expect a
wall of real drift on first contact; every Omitted* list is an explicit decision.

## Provenance
Round-2 review, webapp agent, rank 2, Strong.
