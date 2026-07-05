# Epic 2 — Execution roles (sub-plan)

## Outcome

Two role-specialized units on top of today's general coder:
- A **testing agent** that authors the failing acceptance test BEFORE the coder implements
  (wires the dormant `buildTddVerifyWorkflow`), selected automatically for behavior-adding code
  changes by the intake router.
- An **observing agent** that reproduces a confirmed regression in its own worktree (new
  `buildObserveWorkflow`), spawned by the Observer instead of the loop merely filing an issue.

Both carry an orthogonal `executionRole` field ("tester"|"observer") threaded end-to-end so the
UI and audits can see role, without overloading the runtime `kind`.

## Work table

| # | Concern | Complexity | Depends on | Touches |
|---|---|---|---|---|
| 01 | `executionRole` dimension (types + DTO mirror) | mechanical | — | src/types.ts, webapp/src/lib/dto.ts, src/squad-manager.ts |
| 02 | `buildObserveWorkflow` reproduce/bisect builder | mechanical | — | src/workflow/verify-workflow.ts, tests/workflow.test.ts |
| 03 | `VerifySpec.mode` + 3-way driver selection | architectural | 02 | src/types.ts, src/squad-manager.ts, tests/workflow.test.ts |
| 04 | Router emits `mode:"tdd"` for change-risky tasks | mechanical | 03 | src/intake.ts, src/squad-manager.ts, tests/intake.test.ts |
| 05 | Observer→dispatch seam (spawn observing agent) | architectural | 01, 02, 03 | src/observer.ts, src/squad-manager.ts, tests/observer.test.ts |

## Batch order

- **Batch A (parallel):** 01, 02 — independent, no shared files of consequence (01 touches
  types.ts type-defs + dto + create/queuedDto builders; 02 is a self-contained new function +
  test). If run by the same agent, do 01 then 02.
- **Batch B:** 03 — adds `VerifySpec.mode` and the driver switch that consumes `buildObserveWorkflow`.
- **Batch C (parallel):** 04, 05 — both consume 03's field/switch and are otherwise disjoint (04
  in intake.ts, 05 in observer.ts); 05 also consumes 01's `executionRole`.

## Dependency graph (30s check per edge)

- `02 → 03`: `git grep -n buildObserveWorkflow src/squad-manager.ts` returns a hit inside
  `makeDriver`'s workflow switch → 03 actually calls 02's builder.
- `03 → 04`: `git grep -n "verifyMode" src/squad-manager.ts` shows it threaded at the route-merge
  site (~line 2738) → 04's `decision.mode` reaches `CreateAgentOptions.verifyMode`.
- `03 → 05`: `git grep -n 'verifyMode:\s*"observe"' src/squad-manager.ts` shows the spawnObserver
  wiring passes mode "observe" → 05's spawned agent runs the observe workflow.
- `01 → 05`: `git grep -n 'executionRole:\s*"observer"' src/squad-manager.ts` shows the observer
  spawn stamps the role → 01's field is populated by 05.
- `02 → 05`: an observing agent spawned by 05 runs a graph whose nodes are `reproduce`/`report`
  (02's builder) — verify via the acceptance test in 05.

## Global scope boundary (applies to every leaf)

- Do NOT extend `AgentKind` — both new units are `kind:"workflow"`. Role lives in `executionRole`.
- Do NOT rename or touch the RBAC `Role` type (types.ts:1027) or `Actor.role`.
- Do NOT change `proofGate`/land semantics, the fixup/escalate cascade, or `detectVerify`.
- Do NOT build a validator that scores against declared criteria — that is Epic 3, not here. The
  testing agent still authors AND the same run implements against its own test; independence is
  Epic 3's job. Epic 2 only ensures the test is written FIRST, by a distinct node.
