# Epic 2 — Execution roles
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/workflow/verify-workflow.ts, src/intake.ts, src/types.ts, src/squad-manager.ts, src/observer.ts
SUBPLAN: plans/meta-autonomous-fleet/epic-2-execution-roles/

## Goal

Specialize the general coding unit into the roles the architecture names: a **testing agent** that authors the acceptance test *before* the coder touches it (so the gate isn't the coder grading its own homework), and an **observing agent** that reproduces behavioral truth against the running system in its own worktree.

## Approach

Every dispatched unit today is a general coding agent (`kind: omp-operator`, `approvalMode: "yolo"`, routed through `buildVerifyWorkflow`); verification is a downstream command gate **inside that same agent**. `AgentKind` (`src/types.ts:55`) has no role dimension keyed to task character.

**Testing agent — mostly wiring.** `buildTddVerifyWorkflow` (`src/workflow/verify-workflow.ts:73`) already prepends a `write-test` agent node (`WRITE_TEST_PROMPT`: author failing acceptance tests first, confirm red, do not implement). It's fully built and tested but referenced only in `tests/workflow.test.ts` — `routeIntake` never selects it. Wire it: teach `routeIntake` (`src/intake.ts:44`) to emit a "tdd" process, branch on it in `createWithId` (`src/squad-manager.ts:2736`), and thread a role field through `CreateAgentOptions → AgentDTO`.

**Observing agent — promote existing logic.** The reproduce logic already lives in the Observer loop (`src/observer.ts` `confirmedGate` single-retry "a regression is only real if it REPRODUCES"), but as a daemon loop that files issues, not a worktree agent. Give it a workflow analogous to `buildVerifyWorkflow` whose command node runs a reproduce/bisect script in an isolated worktree, plus a role/kind entry and a `routeIntake` branch (or an Observer→dispatch path that spawns it with that role).

## Decomposition seed (candidate leaves for the sub-plan)

- Extend `AgentKind`/add a `role` to `CreateAgentOptions` + `AgentDTO` + DTO mirror (`webapp/src/lib/dto.ts`); round-trip test.
- Teach `routeIntake` to emit a "tdd" process for change-risky tasks; unit-test the router decision.
- Branch `createWithId` to select `buildTddVerifyWorkflow` for the tdd process.
- New `buildObserveWorkflow` (reproduce/bisect command node) + role entry.
- Observer→dispatch seam: spawn an observing agent on a confirmed regression instead of only filing an issue.

## Verify

Dispatch a change-risky task; confirm a `write-test` agent runs first and lands a failing test before the coder implements (transcript shows red-then-green by *different* agents). Trigger a reproducible regression; confirm an observing agent spawns in its own worktree and reproduces it rather than the Observer merely filing an issue.
