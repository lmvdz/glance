# Verification — graph-model unit test + smoke protocol
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/graph-model.test.ts, README.md

## Goal
Leave one runnable check on the only non-trivial pure logic in the clone — the DTO→graph selector —
and document the manual smoke protocol for the canvas/UI parts that are DOM-coupled.

## Approach
1. **`graph-model.test.ts`** (`bun:test`, no framework beyond it, no fixtures-on-disk):
   - **feature→node:** N `FeatureDTO` → N nodes; node `id===feature.id`, `status===feature.stage`,
     `ref` falls back to a short id when `issueIdentifiers` empty.
   - **blockedBy→edge:** a feature whose attached issue `blockedBy` resolves to another feature emits
     exactly one `depends_on` edge in the right direction; an unresolvable `blockedBy` emits none.
   - **relates_to:** two features sharing a `planDir` get a `relates_to` edge; different dirs don't.
   - **agentsByFeature:** agents bucket by `featureId`; an agent with no/unknown `featureId` is
     excluded from buckets (and counted as unassigned).
   - **empty/edge:** `buildGraphModel([], [])` → `{nodes:[],edges:[],agentsByFeature:empty}`, no throw.
   - **stable ids:** same input twice → identical node ids (position-cache contract).
2. **Wire to the gate.** `graph-model.ts` must be importable under `webapp/`'s tsconfig; the test runs
   under root `bun test` (it lives in `webapp/src` but is plain TS — confirm `bun test` picks it up,
   else add a `webapp` test script and call it from `tests/webapp.test.ts`). Keep it dependency-free.
3. **README smoke protocol.** Document under the web-rewrite section: build `webapp`, run
   `OMP_SQUAD_WEBAPP=1 omp-squad up`, spawn 2–3 agents across a repo with a plan dir, open `/`,
   exercise: Structure↔Graph toggle, feature nodes + dependency edges, agent rings (incl. a
   `needs-input` amber ring), detail slide-over + hover card.

## Cross-Repo Side Effects
None. Pure test + docs.

## Verify
- `cd webapp && bun test` (or root `bun test`) runs `graph-model.test.ts` green.
- `bun run check && bun test` (root gate) stays green — no regression to existing suites incl.
  `tests/webapp.test.ts` and `tests/web.test.ts`.
- The smoke protocol in README is reproducible end-to-end.

## Resolution
graph-model.test.ts (8 cases, bun test) covers node mapping, blockedBy edges, relates_to, agent bucketing, empties, stable ids; webapp test script added; README smoke protocol documented. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
