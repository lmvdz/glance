# Design: omp-graph UI (piyaz clone in `webapp/`)

## Approach

Lift piyaz's canvas force-graph engine into the existing `webapp/` Vite SPA, restyle the SPA with
piyaz's design tokens, and feed the engine an omp-squad domain model derived from the live
`SquadEvent` WebSocket stream. Render two modes (Structure list ↔ Graph canvas) with a Motion
slide-over detail panel. The graph is **two-layered**: `FeatureDTO` task nodes as the base,
`AgentDTO` presence overlaid on the feature each agent is executing.

Served behind the **existing default-off `OMP_SQUAD_WEBAPP=1` seam** (`plan.md` / `src/server.ts`);
the live `src/web/index.html` dashboard is untouched until a later cutover.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| License | Lift engine verbatim; `webapp/` → AGPL-3.0 + attribution | Recreate clean from notes | User chose accept-AGPL; the 3 kLOC of canvas/force tuning is the hard, high-value part |
| Token convention | Adopt piyaz default-dark + `html.light`; rewrite shadcn semantic tokens to piyaz values | Keep shadcn `.dark` + oklch-neutral | Cloning piyaz's look; `getCanvasTheme()` needs the piyaz var names so DOM + canvas share one source |
| Primitives | Keep shadcn (new-york), restyle via tokens | Port piyaz's 40 hand-rolled primitives | Less code, less AGPL surface, webapp already on shadcn |
| Node domain | `FeatureDTO` as base task nodes | Issue-level nodes | Features are already derived on the wire (roster + `features-changed`); issue nodes need a full Plane fetch |
| Edge domain | `depends_on` from `IssueRef.blockedBy`; `relates_to` from shared `planDir`/repo | Explicit edge store | omp-squad has no edge table; derive from existing DTO fields, degrade gracefully when sparse |
| Agent layer | Overlay `AgentDTO` on its `featureId` node (status ring + hover card) | Agents as first-class nodes | "Both layered" — keeps the dependency graph legible, agents annotate it |
| Transport | WS `SquadEvent` (`roster`/`agent`/`features-changed`) + HTTP `/api/features`; replace TanStack/SSE | Keep TanStack Query | webapp is a thin WS client of SquadServer (README); no RSC/SSE available |
| Serve | Behind existing `OMP_SQUAD_WEBAPP=1`, default-off | Cut over now | Matches the foundational scaffold; reversible, zero risk to the live dashboard |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Sparse dependency edges (omp-squad has weaker explicit deps than piyaz) | significant | Start with `blockedBy` + plan-dir grouping; when no edges resolve, the sunflower-spiral seed still gives a clustered, readable layout (no edges ≠ broken) |
| Graph remounts on every `roster`/`agent` WS event → simulation re-explode | significant | piyaz's module-level position cache (pattern C) keyed by **stable feature id** — ensure node ids = `FeatureDTO.id`, not array index |
| Canvas redraw storm from high-frequency `agent` events | minor | Reuse `needsRedrawRef` + tier `flowDots`/`halo` toggles; coalesce agent-overlay redraws to one rAF per tick |
| AGPL contaminates `webapp/` | accepted | Add `webapp/LICENSE` (AGPL-3.0), `NOTICE` crediting FrkAk/piyaz, SPDX headers on lifted files |
| Lifted imports reference Next-only modules (`next/dynamic`, `"use client"`, `next/headers`) | minor | Strip directives; replace `next/dynamic({ssr:false})` with a plain import (Vite has no SSR) |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| "The engine assumes a `projectId` cache key — omp-squad has no single project" | significant | Cache key = a stable graph scope id (e.g. `"fleet"` or the active repo/ProjectDTO id); single global graph is fine |
| "piyaz statuses (`draft…done`) ≠ omp `FeatureStage`" | significant | `statusColor()` is the single mapping point — remap stage→color there; keep the hollow `plannable/ready` treatment for `planned/issues-created` |
| "Two node types (feature + agent) breaks the homogeneous `GraphNode`" | significant | Agents are NOT nodes — they're an overlay pass in the renderer keyed by `featureId`; the simulation stays single-type |

## Open Questions

None blocking. Plane-fetch enrichment for true issue-level dependency edges is a deliberate later
upgrade (noted as a `ponytail:` ceiling in concern 04), not part of this clone.
