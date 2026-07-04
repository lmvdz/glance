# Workbench Shell Foundation
STATUS: cancelled
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/App.tsx, webapp/src/components/layout/*, webapp/src/components/workbench/*, webapp/src/index.css

## Goal
Create the three-pane operator workbench: left project tree, middle console/content slot, collapsible right detail rail.

## Approach
- Add a `WorkbenchShell` component that owns layout only.
- Keep hash routing initially; do not introduce a router dependency.
- Preserve existing views by rendering them in the middle slot.
- Add shell state for selected project and detail subject.
- Make rail width tokenized and collapsible.
- Keep mobile behavior simple: left rail hidden behind current mobile command entry; right rail overlays.

## Cross-Repo Side Effects
None.

## Verify
- `cd webapp && bun run typecheck`
- Existing routes still render: `#/agents`, `#/project/<repo>`, `#/console`, `#/heatmap`.
- Opening/collapsing right rail does not resize left rail.
