# One ledger implementation — collapse 8 hand-rolled stateDir persistence clones
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: moderate
TOUCHES: src/ledger.ts (new), src/dispatch-ledger.ts, src/removed-ledger.ts, src/goal-overlap-ledger.ts, src/race-ledger.ts, src/land-ledger.ts, src/memory/failure-memory.ts, tests/ledger.test.ts
MODE: afk

## Goal
One deep module owns the durable-JSON stateDir idiom (read-with-corrupt→empty, best-effort atomic
durable write) in four shapes: cached set, cached map, uncached map, uncached append-list. The six
clone files shrink to declarations + their own policy (pair-keying, first-wins + pending
refinement, tombstone-also-name, streak clear-on-success); exported interfaces unchanged, zero
caller edits. `land-ledger.ts` — today the ONLY lane file on raw non-atomic `node:fs` — gets
atomic durable writes by construction. Retention guards (maxEntries/minRetained, POSITION.md
FIELD-1) implemented + tested in the module; deliberately NOT wired onto the audit trails
(forced-land / validator-override must never silently drop — compliance reads them).

## Deliberately out
automation-log.ts + metrics.ts (the ring+spool idiom pair) — different shape, admits its own
duplication in its header; absorb in a later iteration if the ring shape earns a third copy.
