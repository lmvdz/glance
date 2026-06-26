# Page Polish and Verification
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/views/*, webapp/src/components/layout/*, README.md

## Goal
Make the full page system feel precise, compact, accessible, and real.

## Approach
- Run one density pass after pages land: remove duplicated headers, over-padding, fake buttons, route-only dead ends.
- Ensure every interactive element is a real `button` or `a` with focus.
- Check all list/detail flows: click left tree item → middle context updates or right rail opens.
- Ensure loading, empty, and error states for data-driven views.
- Update README with final route/page taxonomy.

## Cross-Repo Side Effects
None.

## Verify
- `cd webapp && bun run typecheck`
- `bun test` only if tests were added/modified.
- Search checks: no `<div onClick>`, no `href="#"`, no `sample`/`demo` text in finished views.
- Manual route smoke list: command, projects, fleet, profiles, tournaments, observability, governance, settings, heatmap.
