# Retention, compaction, and handover provenance
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/archive.ts (new), src/after-action.ts, src/db/migrations.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
Decisions and the evidence known at the time survive whole. Everything else may be compacted — but the
cut is declared, authorized, and never mistaken for the record.

## Approach
Reference: `reference/03-machinery.html` → 5a, 5b; `reference/02-surfaces.html` → 4b, 8a, 8b.

1. **Decisions, their then-known evidence, and human text are preserved at full fidelity.** They are not
   compaction candidates, ever.
2. Compaction of other material **names what was cut, when, and who authorized it** — a policy authored
   by a human, not a background default.
3. A compacted record is **labelled as compacted at every read**. A summary that can be mistaken for the
   record is the failure mode this concern exists to prevent.
4. **Handover retains author attribution.** Work moved between agents keeps who did what.
5. **Stale evidence is marked stale at the point of transfer** — "these results are 34 minutes old;
   whoever picks this up should re-run them against today's main" — and re-verification against current
   main is required rather than suggested.
6. This splits concern 06: live regenerated summaries there, immutable archive semantics here.

## Cross-Repo Side Effects
None.

## Verify
- A decision survives a compaction pass byte-identical, with its evidence.
- Every compacted record renders its cut, its date, and its authorizer.
- A handover shows what carries over and what does not BEFORE it is confirmed.
- Evidence older than its freshness window is marked stale at transfer, not silently carried.
- The tree shows a handover as history, never as a gap.
