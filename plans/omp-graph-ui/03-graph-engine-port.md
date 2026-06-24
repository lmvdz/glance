# Graph engine port — lift piyaz's d3-force canvas
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/graph/*, webapp/src/lib/graph-types.ts, webapp/package.json

## Goal
Bring piyaz's canvas force-directed graph engine into the SPA as a domain-agnostic component that
takes `{ scopeId, nodes, edges, selectedNodeId, onSelectNode, … }` and renders/animates them. This
is the high-value, hard-to-rebuild core — lifted verbatim, then de-Next-ified and re-typed.

## Approach
1. **Deps.** Add `d3-force`, `d3-quadtree` (+ `@types/d3-force`, `@types/d3-quadtree`) to
   `webapp/package.json`.
2. **Lift four files** into `webapp/src/components/graph/` with SPDX/attribution headers (concern 01):
   - `graphConstants.ts` — verbatim (node sizing, perf tiers, `DARK_THEME`/`LIGHT_THEME`,
     `getCanvasTheme()`, `statusColor()`, easing, hex helpers).
   - `useForceSimulation.ts` — verbatim (force config, position cache, `forceDecongest`, sim state machine).
   - `ForceGraph.tsx` — strip `"use client"`; keep the canvas render loop, pan/zoom/drag, camera
     (`fitTransform`/`focusTransform` with `rightInset`).
   - `GraphControls.tsx` — verbatim (zoom/fit/reset overlay).
3. **Re-type to local domain.** Create `webapp/src/lib/graph-types.ts` exporting the engine's
   contract decoupled from omp-squad DTOs:
   ```ts
   export type EdgeType = "depends_on" | "relates_to";
   export interface GraphNodeInput { id: string; title: string; ref: string; status: string; tags: string[]; }
   export interface GraphEdgeInput { source: string; target: string; type: EdgeType; }
   ```
   Replace piyaz imports `@/lib/data/views` (`TaskGraphSlim`/`TaskGraphEdge`) and `@/lib/types`
   (`EdgeType`) with these. The internal `GraphNode`/`GraphLink` in `graphConstants.ts` stay as-is
   (they already carry only `{id,title,taskRef,status,tags}` + sim fields → rename `taskRef`→`ref`
   or keep `taskRef` and map at the boundary; keep — fewer edits).
4. **Remap status palette.** `statusColor()` (`graphConstants.ts`) is the single mapping point.
   Adjust the `switch` to omp `FeatureStage`: `done`→done green, `landed`→done green,
   `review`→in_review purple, `in-progress`→progress amber, `issues-created`/`planned`→planned blue
   (hollow), `diverged`→cancelled red. Default → draft. (Edge palette `EDGE_COLOR` keeps
   `depends_on` blue / `relates_to` purple-dashed.)
5. **No SSR.** Concern 05 imports `ForceGraph` directly (no `next/dynamic`); ensure no top-level
   `window`/`document` access at module scope (piyaz already guards via `typeof document`).

## Cross-Repo Side Effects
None outside `webapp/`. Establishes `graph-types.ts` as the contract concerns 04/06 build on.

## Verify
- `cd webapp && bun run typecheck` passes (engine compiles against `graph-types.ts`, no Next imports).
- A throwaway `App.tsx` mount feeding 5 hand-built `GraphNodeInput` + 4 edges renders a settling
  canvas with draggable nodes, zoom controls, and stage-colored fills. (Removed in concern 05.)
- `tests/webapp.test.ts` build gate green.

## Resolution
Lifted graphConstants/useForceSimulation/ForceGraph/GraphControls verbatim (de-Next-ified, imports swapped to @/lib/graph-types); statusColor remapped to FeatureStage. typecheck clean. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
