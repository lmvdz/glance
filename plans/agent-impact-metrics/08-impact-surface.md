# ImpactSurface (webapp)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 07
TOUCHES: webapp/src/components/hub/ImpactSurface.tsx (new), webapp/src/lib/impact.ts (new), webapp/src/App.tsx, webapp/src/lib/api.ts, webapp/src/index.motion.test.ts? (only if route registry tests exist), tests via webapp suite

## Goal
The operator-facing read: per-unit vectors and cohort views that cannot be misread as execution or quality verdicts.

## Approach
- Hub Surface convention: dispatch from the `route.view` chain (webapp/src/App.tsx:84-95); pure transforms + `coerce*` (survive old-daemon payloads) in webapp/src/lib/impact.ts; fetch via `apiJson`.
- House rule enforced structurally: every number renders with its "what this cannot see" sentence; a failed read renders as a declared failure, not an empty state; the task-class-matrix "OBSERVATIONAL, NOT A DECISION ORACLE" note is the precedent and gets equal prominence here.
- **No verdict quadrant.** Primary view is a scatter of raw counts (cross-feature calls vs % ranges unmodified, churn bucket encoded), mechanism-named axes: "statically referenced (cross-feature calls)" / "unmodified ranges (churn-adjusted)". Cells/labels never say "dead" or "load-bearing" — say "no cross-feature static refs". `unresolved` and `not instrumentable` are visible categories with their shares, not footnotes.
- Instrumentability leads the per-unit card; gap rows sit in the same table as numeric rows at equal visual weight (anti selection-on-measurability).
- MondaySurface link-out only; do not fold in (different question: adoption vs impact).

## Cross-Repo Side Effects
None.

## Verify
Vitest on coerce/transform pures incl. malformed payload; visual check via scratch daemon with a seeded mixed cohort (numeric + gap + backfilled units) — confirm a reader cannot find a single composite number anywhere on the page.
