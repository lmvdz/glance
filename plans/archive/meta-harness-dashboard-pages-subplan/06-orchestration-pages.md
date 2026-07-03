# Orchestration Pages
STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/FeaturesView.tsx, webapp/src/components/views/ProjectView.tsx, webapp/src/components/views/TournamentView.tsx, webapp/src/components/views/LandingGateView.tsx, webapp/src/components/views/ConflictResolverView.tsx

## Goal
Implement plan mode, best-of-N tournament bracket, landing gate diff review, cross-repo orchestration, and conflict auto resolver surfaces.

## Approach
- Plan Mode: high-level intent, step breakdown, recommended roster, runtime mix, simulate/approve actions.
- Tournament: candidate list, winner summary, scorer breakdown, verification gates, land winning candidate action.
- Landing Gate: diff/commits/checks/artifacts tabs, provenance chain, gate scores, land/request changes actions.
- Conflict Resolver: current/incoming/resolution columns, reasoning rail, verification gate, accept/retry/human review actions.
- Cross-repo orchestration: repo cards around a central merge point with conflict risk rail.

## Cross-Repo Side Effects
Potentially depends on existing `best-of-n-selection`, `resolve-conflict`, and planner APIs; do not invent mutations without daemon support.

## Verify
- Existing feature/project pages still render.
- Actions with no daemon support are disabled and explicit.
- Diff panes are readable without horizontal page scroll where possible.
