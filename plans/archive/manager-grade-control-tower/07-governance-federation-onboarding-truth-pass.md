# Governance/federation/onboarding truth pass
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts, src/authz.ts, src/scheduler.ts, src/federation.ts, src/squad-manager.ts, webapp/src/lib/dto.ts, webapp/src/components/views/DashboardPagesView.tsx, webapp/src/components/views/NetworkView.tsx, webapp/src/components/spawn/NewWork.tsx, webapp/src/components/layout/TopBar.tsx, webapp/src/**/*.test.ts

## Goal

Make governance, federation, and onboarding honest and useful. If the backend has real data, show it. If a capability is not configured or not built, say exactly that and provide the next concrete action. No primitive placeholder dashboards.

## Approach

- Governance:
  - Read-only first. Show current auth mode/role, route capability tiers, WIP cap, resource/admission limits, coordinator/federation mode, audit status, and warning state.
  - Do not add save buttons for policies without backend mutation APIs.
  - Link governance-relevant audit rows.
- Federation:
  - Keep existing `/api/federation`, `/api/presence`, `/api/leases`, `/api/plane/issues` reads.
  - Poll or WS-refresh them; current page fetches once.
  - If DB registry mode intentionally returns empty federation data, show “global federation unavailable in DB-registry mode by design,” not “No federation peers.”
  - If no peers exist, show local-only diagram/empty state with coordinator setup hint.
  - Collision/lease rows should link to repo/project context.
- Onboarding:
  - Align checklist with actual first-run paths: auth/file-token or DB org, daemon cwd/repo, optional Plane config, model/profile selection, New Work or Control Tower first agent, optional federation.
  - If the reference image is available in repo/session, match it. If not, use app tokens/components and record that the visual reference is missing instead of guessing.
  - CTAs must route to actual controls that complete the step.

## Cross-Repo Side Effects

None.

## Verify

- Governance page displays live role/auth mode and resource/WIP values without disabled fake controls.
- Federation peer/presence/lease changes update without full reload; DB-registry mode explains its empty state.
- Fresh file-mode daemon with no Plane shows a truthful onboarding path and marks Plane as optional.
- Onboarding CTAs open Control Tower/New Work/settings/governance pages as appropriate.
