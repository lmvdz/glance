# Primitive kit — piyaz-skinned shadcn primitives
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/ui/*, webapp/package.json

## Goal
The dense operational chrome the dashboard needs — table, dialog, toast, tooltip, select, input,
badge, skeleton, empty-state, error-state — as piyaz-skinned primitives, so later concerns compose
the UI instead of hand-rolling controls.

## Approach
Port `squad/ompsq-55`'s `webapp/src/components/ui/*` (badge, button, card, dialog, empty-state,
error-state, input, select, skeleton, table, toast, tooltip) plus `lib/tick.tsx` + `lib/theme.ts`.
Reskin: they use the green-shadcn token set — point their classes at the **piyaz tokens** already in
`webapp/src/index.css` (`bg-surface`, `text-text-primary`, `border-border`, `text-accent`, the
`--shadow-*`/glow vars). Keep the existing `cn()` (`lib/utils.ts`) and the existing `button.tsx`
shape. Add radix deps: `@radix-ui/react-{dialog,select,toast,tooltip}` (slot already present).
ponytail: reskin, do not redesign — these primitives exist and are showcased on ompsq-55.

## Cross-Repo Side Effects
None outside `webapp/`. Establishes the primitive vocabulary every later concern imports.

## Verify
- `cd webapp && bun run typecheck && bun run build` green.
- A throwaway `/dev/primitives` mount renders the kit in piyaz colors (dark + indigo accent), light
  mode flips correctly. (Optional; remove or keep as a dev route.)

## Resolution
Ported ompsq-55's shadcn primitives (badge/button/card/dialog/input/select/table/toast/tooltip/skeleton/empty/error + agent status comps) into components/ui + components/agent; added a piyaz-valued compat token layer to index.css so they render in the Raycast skin; added radix deps. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0; `cd webapp && bun run build` + `bun run test` 14/0; runtime smoke OK).
