# Plan-DAG validator: detect cycles + unresolved deps

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/planGraph.ts, webapp/src/lib/planGraph.test.ts
PLANE: OMPSQ-343 — https://app.plane.so/inkwell-finance/browse/OMPSQ-343/

## Goal
A plan dependency graph with a cycle or a dangling dependency is today rendered as if
valid — `assignColumns` silently returns depth 0 on a back-edge (`planGraph.ts:90`) and
`buildPlanGraph` silently drops edges to unknown concern numbers (`:134`). Surface both
as structured warnings, computed from the SAME edge map the diagram renders (so the
validation can never disagree with the layout — red team A-S6).

## Approach
1. **Add `validatePlanGraph` to `webapp/src/lib/planGraph.ts`**, next to `buildPlanGraph`
   (which already builds the canonical `incoming: Map<string, Set<string>>` file→prereq
   edge map). Single implementation — do NOT duplicate this into the daemon or into any
   skill (concern 06 ships the result to those consumers).
   ```ts
   export interface PlanGraphValidation {
     cycles: string[][];                                  // each cycle as an ordered list of concern file names
     unresolvedDeps: { concern: string; missingNum: number }[];
   }
   export function validatePlanGraph(
     nodes: PlanNode[], incoming: Map<string, Set<string>>, byNum: Map<number, string>,
   ): PlanGraphValidation { ... }
   ```

2. **Cycle detection** — reuse the white/gray/black shape already in `assignColumns`
   (`:85-99`). That function's `visiting.has(id)` branch already *detects* a back-edge;
   it just throws the information away by returning 0. The validator walks the same
   `incoming` map with a DFS that, on hitting a gray node, records the path from that
   node back to itself as a cycle. Collect all distinct cycles.

3. **Unresolved-dep detection** — in `buildPlanGraph`'s blocker loop (`:128-135`), a
   referenced blocker number `bn` with `byNum.get(bn) === undefined` is exactly an
   unresolved dependency (today silently skipped by `if (from && ...)`). Surface each as
   `{ concern: c.file, missingNum: bn }`. Have `buildPlanGraph` collect these as it
   already iterates, and expose them to `validatePlanGraph` (or recompute with the same
   parse to stay pure — prefer threading them out of the one existing loop so the parse
   isn't duplicated).

4. **Drop orphan detection** — the design pass cut it: a concern with no in/out edges is
   a normal batch-0 root, so orphan warnings are mostly false positives (red team
   B-S4/M1). Cycles + unresolvedDeps only.

## Cross-Repo Side Effects
None — pure function in the webapp lib. Consumed by concern 06.

## Verify
- `bun test webapp/src/lib/planGraph.test.ts` — add cases: a 3-node cycle →
  `cycles.length === 1` with the 3 files; a concern blocked by a non-existent number →
  one `unresolvedDeps` entry; a clean linear plan → both arrays empty. The existing
  `planGraph.test.ts` is the home for these.
- Confirm the cycle the validator reports matches the nodes the diagram lays out
  (same `incoming` map) — no second parser.
