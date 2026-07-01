# Surface plan-DAG warnings (UI banner + skill pre-flight)

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/PlanFlowDiagram.tsx, webapp/src/components/TaskDetail.tsx, src/features.ts, ~/.claude/skills/plan-to-plane, ~/.claude/skills/promote-issue, ~/.claude/skills/claim-and-implement
PLANE: OMPSQ-344 — https://app.plane.so/inkwell-finance/browse/OMPSQ-344/

## Goal
Make the validation from concern 05 visible: a non-blocking warning banner in the Plan
flow UI, and a pre-flight check in the three pipeline skills — without duplicating the
validator (red team A-S6/B-S4).

## Approach
1. **UI banner.** `PlanFlowDiagram.tsx` (renders the DAG; consumes the nodes/`incoming`
   from `planGraph.ts`) calls `validatePlanGraph(...)` on the data it already has and,
   when `cycles.length || unresolvedDeps.length`, renders a dismissible warning strip
   above the diagram: *"⚠ 1 dependency cycle: 02 → 04 → 02"* and *"⚠ concern 05 blocked
   by missing concern 12."* Cycle-member nodes get a distinct border. Warning-only — the
   diagram still renders (it already tolerates these via the silent fallbacks). This is
   in the same component path as the existing "Plan flow" focus view in `TaskDetail.tsx`.

2. **Server payload (optional, for non-UI consumers).** The webapp gets concerns via the
   existing pipeline payload (per the `planGraph.ts:7` comment) — there is NO
   `/api/plans/:name` endpoint and we do NOT add one (red team B-S4). For the skills,
   expose the validator result through the path they already use to read plan docs:
   add a tiny CLI subcommand or reuse an existing plan-reading entrypoint in the daemon
   that prints `{cycles, unresolvedDeps}` as JSON for a given `plans/<name>/` dir. If
   `src/features.ts` already parses concerns server-side (`parsePlanConcerns:253-362`),
   add a `validatePlanConcerns(dir)` that builds the same edge map and calls a shared
   pure routine — keep ONE algorithm (import the webapp lib's logic or factor the pure
   core into a location both can import; do not hand-copy the DFS).

3. **Skill pre-flight.** In `plan-to-plane`, `promote-issue`, and `claim-and-implement`,
   add a step before they act on a plan: run the validator (via the CLI/JSON from step
   2) and, if cycles or unresolved deps exist, print the warning and ask for explicit
   confirmation before proceeding. Warning-first — NOT a hard gate in v1 (promotion to a
   hard gate is a later call; do not pre-commit). The skills are markdown instructions:
   they should *invoke* the validator, never embed a copy of it.

## Cross-Repo Side Effects
Depends on concern 05 (`validatePlanGraph`). The src↔webapp sharing decision: prefer a
single pure core both import; if the build roots make that impractical, have the daemon
compute and the skills consume the daemon's output — never two implementations.

## Verify
- `bun run typecheck` (webapp + src) clean.
- Author a plan dir with a deliberate cycle; open it in the UI → banner appears, cycle
  nodes highlighted, diagram still renders.
- Run `plan-to-plane` against that dir → it prints the warning and asks to confirm.
- A clean plan → no banner, skills proceed silently.
