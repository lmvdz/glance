# Overview — omp-graph UI: clone piyaz's force-graph into `webapp/`

Decomposition of "clone piyaz's UI and adapt it for omp-graph", driven by `BRIEF.md` + `DESIGN.md`.
All work lands in the new `webapp/` Vite SPA (React 19 · Tailwind v4 · shadcn), served behind the
existing default-off `OMP_SQUAD_WEBAPP=1` seam. The live `src/web/index.html` dashboard is untouched.

**License posture:** user accepted AGPL. The graph engine is lifted verbatim from FrkAk/piyaz
(AGPL-3.0); `webapp/` becomes AGPL-3.0 with attribution (concern 01).

**Domain ("both layered"):** `FeatureDTO` (`src/types.ts:132`) = base task nodes; `AgentDTO` (`:167`)
overlaid via `featureId` (`:207`). Dependency edges from `IssueRef.blockedBy` (`:67`).

---

## Scope table

| # | Concern | Complexity | TOUCHES |
|---|---|---|---|
| 01 | License & provenance (AGPL + attribution) | mechanical | `webapp/LICENSE`, `webapp/NOTICE`, `README.md` |
| 02 | Design tokens + fonts port | architectural | `webapp/src/index.css`, `webapp/package.json` |
| 03 | Graph engine port (d3-force canvas) | architectural | `webapp/src/components/graph/*`, `webapp/src/lib/graph-types.ts`, `webapp/package.json` |
| 04 | omp-graph data model + WS data layer | research | `webapp/src/lib/graph-model.ts`, `webapp/src/lib/ws.ts`, `webapp/src/hooks/useSquad.ts` |
| 05 | Dual-mode shell (Structure ↔ Graph + slide-over) | architectural | `webapp/src/components/layout/*`, `webapp/src/components/shared/ViewTabs.tsx`, `webapp/src/App.tsx`, `webapp/package.json` |
| 06 | Agent overlay (the "both layered" feature) | architectural | `webapp/src/components/graph/ForceGraph.tsx`, `webapp/src/lib/graph-model.ts` |
| 07 | Verification (graph-model unit test + smoke) | mechanical | `webapp/src/lib/graph-model.test.ts`, `README.md` |

---

## Dependency graph & shared-file analysis

**Shared file `webapp/package.json`** — concerns 02 (fonts), 03 (d3-force, d3-quadtree), 05 (motion)
all add deps. Per the SAME-FILE rule these dep bumps MUST be sequential, not parallel agents.

**Engine→model→overlay chain** — 03 defines `GraphNode`/`GraphLink`; 04 produces them from DTOs;
06 extends both. Hard ordering: `03 → 04 → 06`. Shell (05) consumes the engine (03) + data hook (04).

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | — | — |
| 02 | — | — |
| 03 | 02 (package.json only) | `git log --oneline -1 webapp/package.json` shows 02 landed |
| 04 | 03 (uses `graph-types.ts`) | `test -f webapp/src/lib/graph-types.ts` |
| 05 | 03, 04 (imports ForceGraph + data hook) | `test -f webapp/src/components/graph/ForceGraph.tsx && test -f webapp/src/hooks/useSquad.ts` |
| 06 | 03, 04 (edits ForceGraph + graph-model) | same files exist |
| 07 | 04, 06 (tests graph-model + overlay) | `test -f webapp/src/lib/graph-model.ts` |

## Batch order

- **Batch 1 (parallel):** `01` (license/docs) ‖ `02` (tokens + first dep bump).
- **Batch 2:** `03` (engine port; adds d3 deps after 02).
- **Batch 3:** `04` (data model + WS hook).
- **Batch 4 (parallel):** `05` (shell; adds motion) ‖ `06` (agent overlay) — disjoint except neither touches the other's files; 05 owns layout/App, 06 owns ForceGraph/graph-model.
- **Batch 5:** `07` (verification).

Web track is mostly sequential by design (shared `package.json` + the engine chain). One agent
owning the `webapp/` track end-to-end, with each step handed the prior diff, is leaner than
agents fighting over `package.json` (ponytail: shortest diff).

## Verification posture

- **Gate (existing):** `tests/webapp.test.ts` already runs `webapp/` typecheck + content-hashed Vite build. Must stay green after every concern.
- **Unit (new, concern 07):** `graph-model.ts` is a pure DTO→{nodes,edges,agentsByFeature} selector → assert-based test (feature→node mapping, `blockedBy`→edge, agent→featureId bucketing, empty-roster no-throw). No framework beyond `bun:test`.
- **Manual smoke:** `cd webapp && bun run build`, then `OMP_SQUAD_WEBAPP=1 omp-squad up`; spawn 2–3 agents across a repo with a plan dir; open `/`, toggle Structure↔Graph; confirm feature nodes render, dependency edges draw where `blockedBy` exists, agent rings appear on the executing feature, and a `needs-input` agent shows the input-status ring + hover card.

## Status

7/7 done (2026-06-23). Implemented in git worktree on branch `omp-graph-ui` (sibling dir `../omp-squad-omp-graph-ui`). Served behind the existing default-off `OMP_SQUAD_WEBAPP=1` seam; `src/web/index.html` untouched.

Gate green: root `bun run check` (tsc) clean; root `bun test` 492 pass / 0 fail across 82 files (incl. `tests/webapp.test.ts`); webapp `bun run test` 8 pass / 0 fail (`graph-model.test.ts`); `cd webapp && bun run build` produces a content-hashed bundle. Not yet merged to main.
