# omp-graph as a view
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/graph/*

## Goal
Fold the existing force-graph (`omp-graph-ui`) into the shell as the **Graph** nav view — the lens for
clusters/bottlenecks — instead of it being the whole app.

## Approach
Mount `GraphView` (already built) under the shell's `"graph"` route, fed by `buildGraphModel(features,
agents)`. Selecting a node sets the shared `selectedId` → opens the feature detail in the shell (not a
standalone slide-over). Retire the old standalone dual-mode `App` wiring (superseded by concern 02).
Keep the agent overlay (rings/badges) and the status legend.

## Cross-Repo Side Effects
None. Reuses the engine + model from `omp-graph-ui` unchanged.

## Verify
- Graph view renders feature nodes + agent overlay; selecting a node opens that feature's detail in
  the shell; switching to another view and back preserves the layout (position cache).
