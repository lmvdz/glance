# Retention, compaction, and handover provenance
STATUS: done
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

## Built 2026-07-25

`src/archive.ts`. Every record kind is explicitly preserved or compactable, asserted by an
exhaustiveness test — so a new kind cannot be added without someone deciding whether it may be
destroyed. Decisions, rules, readings, objections, human authority and the boundary itself are never
cut, at any age, under any policy.

**Compaction is deletion**, which puts it in concern 12's non-delegatable class. An autonomous
compaction is refused unless a person granted it by name; a person compacting is never blocked.
Planning and applying are separate acts so the consequence is shown before it happens, and the
retention record is written BEFORE anything is removed — a crash between the two leaves a declared cut
with the data still present, which is the recoverable direction.

`compactionNotice` returns a sentence rather than a flag, because a flag becomes a badge and a badge
gets ignored. When nothing was cut it says so; silence would read as loss.

Evidence age is an instruction, not a label — "these results are 34 minutes old; re-run them against
today's main". Never-checked is distinguished from checked-long-ago and never reads as fresh. Handover
names what does NOT come across before it is confirmed, because a human cannot consent to an unnamed
omission, and stale evidence is marked at the point of transfer rather than carried silently.

**One defect found and fixed here, introduced in #264:** `NodeRecordStore.put` validated a handful of
fields while the reader decoded the whole schema, so a record missing a required field was written
successfully and then vanished on read — no error at either end. A write that reports success and
produces nothing is the worst shape absence-as-answer takes. `put` now refuses anything that would not
survive its own round trip, with a regression test.

## Cross-Repo Side Effects
None.

## Verify
- A decision survives a compaction pass byte-identical, with its evidence.
- Every compacted record renders its cut, its date, and its authorizer.
- A handover shows what carries over and what does not BEFORE it is confirmed.
- Evidence older than its freshness window is marked stale at transfer, not silently carried.
- The tree shows a handover as history, never as a gap.
