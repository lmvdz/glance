# Dual-mode shell — Structure ↔ Graph with slide-over detail
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/layout/*, webapp/src/components/shared/ViewTabs.tsx, webapp/src/App.tsx, webapp/package.json

## Goal
Recreate piyaz's two-mode workspace in the SPA: a **Structure** list and a **Graph** canvas over the
same fleet data, with a Motion slide-over detail panel pinned right (graph stays full-bleed).

## Approach
1. **Dep.** Add `motion` to `webapp/package.json`.
2. **`ViewTabs`** — port `components/shared/ViewTabs.tsx` + the `IconGraph`/`IconList` from
   `components/shared/icons.tsx` (or swap to `lucide-react` `Network`/`List`, already a dep —
   ponytail: prefer lucide, fewer lifted files).
3. **`TwoPanelLayout`** — port `components/layout/TwoPanelLayout.tsx` near-verbatim (40/60 desktop
   split, mobile toggle bar). Uses `--topbar-h`/`--viewport-height` tokens from concern 02.
4. **Graph mode** — adapt `components/workspace/graph/WorkspaceGraphView.tsx` as the pattern:
   full-bleed `<ForceGraph>` (concern 03) + a Motion `AnimatePresence` slide-over (`OVERLAY_W_*`,
   `rightInset` fed back to the canvas camera) holding the selected feature's detail. Drop piyaz's
   `MiniTaskRail`/`PropRail` for v1 (ponytail: detail panel only; add the rail later if wanted).
   Keep `StatusLegend` (stage filters) + edge-filter pills, retargeted to omp stages.
5. **Structure mode** — a simple feature list (reuse shadcn primitives, piyaz-styled): one row per
   `FeatureDTO` grouped by repo, each row a stage glyph + title + agent-count + unlanded badge.
   Clicking a row selects it (shared `selectedId` with graph mode).
6. **`App.tsx`** — replace the scaffold. Top bar (fleet counts: agents, `N need input`), `ViewTabs`
   (`structure | graph`, view state in `useState` or URL hash), the active mode, and the detail
   slide-over. Data via `useSquad()` (concern 04) → `buildGraphModel()` for graph mode.

## Cross-Repo Side Effects
None outside `webapp/`. Consumes concern 03 (`ForceGraph`) + concern 04 (`useSquad`,
`buildGraphModel`). Replaces the placeholder `App.tsx` entirely.

## Verify
- `cd webapp && bun run build` green; `OMP_SQUAD_WEBAPP=1 omp-squad up` serves the new shell at `/`.
- Toggling Structure↔Graph keeps the selection; selecting a feature in graph mode slides the detail
  panel in from the right and recenters the node clear of the overlay (`rightInset`).
- Resize below `lg`: graph mode auto-falls back to structure on select (piyaz `WorkspaceClient`
  narrow-viewport behavior); mobile toggle bar works.

## Resolution
TwoPanelLayout + TopBar + StructureView + DetailPanel + GraphView (motion slide-over, rightInset camera) + ViewTabs; App.tsx wires Structure<->Graph over useSquad/buildGraphModel. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
