# Overview — omp-planner: piyaz-style project view + plannable task list

STATUS: cancelled
PRIORITY: p1
REPOS: omp-squad

> 2026-07-01 reconcile: this was BUILT once (commit `0f1323b`) and then DELETED by the `55e2637`
> webapp-shell replacement (2026-06-30 audit) — the project drill-down is gone from the live UI.
> `open` is honest, but an implementer should mine `0f1323b` for the prior task-model/view code
> instead of starting blind, and build against the current TaskList/TaskDetail shell.

Evolve the `webapp/` SPA from a fleet **monitor** into a piyaz-style planning **workspace**: a
left sidebar you drill into per project, and a project view whose tasks show **description +
acceptance criteria + context-bundle preview + properties**. Phase 2 (separate, later) adds the
HumanLayer-style generate→review→approve→dispatch gate; this plan is **Phase 1 only**.

All work lands in `webapp/` (Vite/React/Tailwind, served behind `OMP_SQUAD_WEBAPP=1`) plus the
small server seam that surfaces task bodies. Legacy `src/web/index.html` is untouched.

## Data model — "both layered" (operator decision)

```
Project  = repo                       (manager.projects() / FeatureDTO.repo)
  Feature = plan dir                  (FeatureDTO.planDir — the plan artifact)
    Task  = Plane issue + its body    (listPlaneIssues + NEW issue-detail fetch)
```

- **Project** — a repo wired to a Plane project (`planeRepos()`); also any repo with features.
- **Feature** — a `plans/<name>/` dir surfaced as a `FeatureDTO` (already derived in `features.ts`).
- **Task** — an open Plane issue (`/api/plane/issues`), enriched with its **body** (the promote-issue
  Tier-2 schema: Description, Acceptance Test, Verification gate, Scope) and **properties**
  (state/priority/labels/blockedBy). The **context-bundle preview** = the linked plan-dir concern
  doc excerpt (Goal/Approach) + `TOUCHES` files + `blockedBy` deps — omp-squad's analog of piyaz's
  per-task context bundle.

## Why a server seam is required

`IssueRef` (`src/types.ts:56`) and `/api/plane/issues` carry **no body** — only id/name/state/
blockedBy. The Tier-2 ACs/description live in the Plane issue body (markdown) and/or the plan-dir
concern doc. So a task-detail fetch + parser is the one unavoidable server addition; everything
else is client-side over data already on the wire (`/api/projects`, `/api/features`, the WS roster).

## Scope table

| # | Concern | Complexity | TOUCHES (primary) |
|---|---|---|---|
| 01 | Task-detail server seam (issue body + Tier-2 parser + `/api/tasks/:id`) | architectural | `src/plane.ts`, `src/server.ts`, `src/types.ts`, `tests/plane-tier2.test.ts` (new) |
| 02 | Project model + drill-down sidebar | architectural | `webapp/src/lib/projects.ts` (new), `webapp/src/components/layout/Sidebar.tsx`, `webapp/src/App.tsx` |
| 03 | Project view — plannable task list + properties | architectural | `webapp/src/components/views/ProjectView.tsx` (new), `webapp/src/components/project/TaskList.tsx` (new), `webapp/src/hooks/useTasks.ts` (new) |
| 04 | Task detail — description + ACs + context preview + properties | architectural | `webapp/src/components/project/TaskDetail.tsx` (new), `webapp/src/lib/dto.ts`, `webapp/src/components/agent/Markdown.tsx` (reuse) |
| 05 | Verification + docs | mechanical | `webapp/src/lib/projects.test.ts` (new), `tests/plane-tier2.test.ts`, `README.md`, `docs/operations.md` |

## Dependency graph & batch order

```
01 (server task data) ──▶ 03, 04   (consume /api/tasks)
02 (sidebar/nav)        ──▶ 03      (project route wiring; App.tsx shared with 03)
03, 04 ──▶ 05
```

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | — | — |
| 02 | — | — |
| 03 | 01, 02 | `grep -q "/api/tasks" src/server.ts` AND `test -f webapp/src/lib/projects.ts` |
| 04 | 01 | `grep -q "/api/tasks" src/server.ts` |
| 05 | 03, 04 | the new views exist |

- **Batch 1 (parallel):** `01` (server seam) ∥ `02` (client nav) — file-disjoint (`src/*` vs `webapp/*`).
- **Batch 2 (parallel):** `03` ∥ `04` — both consume `01`; `03` owns ProjectView/TaskList + App route, `04` owns TaskDetail. Minor `App.tsx` co-edit with `02`: sequence `02 → 03`.
- **Batch 3:** `05` (tests + docs).

## Verification posture

- **Server (01):** `parseTier2(body)` is a pure parser → assert-based test (`tests/plane-tier2.test.ts`):
  a real promote-issue body parses into {description, acceptanceCriteria, verification, scope};
  a body missing a section degrades to empty, never throws.
- **Client (05):** `groupProjects(features)` pure → `webapp/src/lib/projects.test.ts`
  (repo→project bucketing, feature→project membership, empty roster).
- **Gate:** `tests/webapp.test.ts` (typecheck + content-hashed build) stays green; root `bun run check` + `bun test`.
- **Manual smoke:** `OMP_SQUAD_WEBAPP=1` daemon → open `/`, drill a project, see its features→tasks,
  open a task, see description + acceptance criteria + context preview + properties.

## Phase 2 (outline only — do NOT build here)

HumanLayer-style generate→review→approve→dispatch. Reuses the **already-specced**
`plans/humanlayer-baml-uplift/` concerns: 04 (artifact comment store), 05 (comment API + SPA panel),
06 (RPI comment feed-forward). Adds: a "draft feature" UI that runs brainstorm→decompose into draft
tasks (description/ACs), lets the operator edit + comment + approve in the planner, and only then
calls `/api/features/from-plan` / dispatch — replacing today's straight-to-factory `auto` mode in
`NewWork.tsx`. Sequenced after Phase 1 lands.
