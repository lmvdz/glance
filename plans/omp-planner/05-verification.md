# Verification + docs

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/lib/projects.test.ts (new), tests/plane-tier2.test.ts (with 01), README.md, docs/operations.md
BLOCKED_BY: 03-project-view, 04-task-detail

## Goal

Lock the two pure pieces with runnable checks and document the new planner surface.

## Approach

### 1. `webapp/src/lib/projects.test.ts` (new) — `groupProjects` (concern 02)
`bun:test`, no fixtures. Assert: features across two repos → two projects with correct
`featureCount`; `agentCount` counts only agents whose `repo` matches; a repo with an `input`/`error`
agent has `waiting > 0` and sorts first; empty input → `[]` (no throw).

### 2. `tests/plane-tier2.test.ts` — landed with concern 01
The Tier-2 parser test (see 01). Listed here so the verification concern owns the "are the checks
green" gate even if 01 lands first.

### 3. Docs
- `README.md` — under the webapp/`OMP_SQUAD_WEBAPP` section: the new **project view** (drill a repo →
  features → tasks with description/acceptance-criteria/context/properties), and the `/api/tasks/:id`
  endpoint. Note Phase 2 (HITL generate→review→approve) is planned, not shipped.
- `docs/operations.md` — one line under the launch section pointing operators at the project view as
  the planning surface (vs the agent/inbox monitor views).

## Verify
- `bun test webapp/src/lib/projects.test.ts tests/plane-tier2.test.ts` green.
- Root `bun run check` + `bun test` green; `tests/webapp.test.ts` (typecheck + content-hashed build) green.
- `cd webapp && bun run build` succeeds.
- README + operations.md render the new section.
