# Onboarding and Empty States
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/views/OnboardingView.tsx, webapp/src/components/ui/empty-state.tsx, README.md

## Goal
Create first-run onboarding and better empty states for pages that depend on daemon contracts.

## Approach
- Onboarding steps: connect first repo/worktree, choose/create named profile, run first agent.
- If no projects/agents exist, route default can show onboarding instead of blank dashboards.
- Empty states should state exactly what data/API is missing and the next action.
- Do not include fictional records.

## Cross-Repo Side Effects
None.

## Verify
- Empty daemon state shows onboarding.
- Existing live daemon state skips onboarding.
- README mentions first-run path.
