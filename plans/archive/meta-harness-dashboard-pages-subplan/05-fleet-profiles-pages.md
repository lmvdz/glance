# Fleet, Agent Profiles, and Memory Pages
STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/views/AgentsView.tsx, webapp/src/components/views/ProfileView.tsx, webapp/src/components/views/ProfileMemoryView.tsx, webapp/src/components/views/CapabilitiesView.tsx, webapp/src/lib/dto.ts

## Goal
Cover squad overview, agent profiles, profile memory, and capabilities/permissions from the image set.

## Approach
- Extend Fleet/Squad overview with grid/list toggle, profile association counts, task counts by profile, heat, runtime, cost, and context load.
- Add Named Profiles page: profile cards, prompt tab, capabilities tab, memory tab, versions tab.
- Add Profile Memory page: append-only memory blocks, distilled facts, raw reasoning harvest, provenance export.
- Add Capabilities page: grants, scopes, effective permissions, audit history.
- Prefer existing live data. If backend contracts do not exist, define DTOs and show honest empty states.

## Cross-Repo Side Effects
Potential later daemon routes: `/api/profiles`, `/api/profiles/:id/memory`, `/api/capabilities`.

## Verify
- Fleet still works with only `SquadState`.
- Profile pages render empty state when daemon has no profile API.
- No static sample profiles in finished state.
