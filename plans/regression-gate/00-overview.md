# Overview — pre-land regression gate

STATUS: done
PRIORITY: p0
REPOS: omp-squad

> WIP gate: scanner showed 5 existing open plan dirs / 19 open concerns. Proceeded because the operator explicitly requested autonomous planning and deferred human review to the plan-approval gate.

## Outcome

- `OMP_SQUAD_REGRESSION_GATE=1` makes every land prove the full repo verification command on the exact merged result before main advances.
- A red baseline does not wedge the fleet: lands are allowed only when merged failures are a subset of base failures.
- New failures block the land and leave main reset to the pre-land `HEAD`.
- Default behavior stays unchanged when the flag is unset.

## Work

| # | Concern | Why it exists | Priority | Complexity | TOUCHES |
|---|---|---|---|---|---|
| 01 | Regression decision core | Make red-baseline set logic deterministic and unit-testable before touching git flow. | p0 | mechanical | `src/land.ts`, `tests/land-regression-decision.test.ts` |
| 02 | Merged-result gate integration | Run the full verification command on merged main, compare against base, and preserve rollback/re-merge behavior. | p0 | architectural | `src/land.ts`, `tests/land-regression-gate.test.ts`, `tests/land-autoresolve.test.ts` |
| 03 | Orchestrator path coverage | Prove single-agent, feature, and auto-resolved land paths all inherit the same flag-gated primitive. | p0 | mechanical | `tests/orchestrator.test.ts`, `tests/manager-autonomy.test.ts`, `tests/land-regression-gate.test.ts` |
| 04 | Operator docs and final verification | Document the opt-in flag and run the required project gate. | p1 | mechanical | `README.md`, `docs/operations.md` |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Pure decision core first; no git/process side effects. |
| 2 | 02 | Depends on 01; owns `src/land.ts` integration and rollback semantics. |
| 3 | 03 and 04 | After behavior exists, add path-level coverage and docs in parallel if docs avoid test files. |

## Dependency graph

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `decideRegressionGate()` and failure extraction tests exist and pass in isolation. |
| 03 | 02 | `landAgent()` blocks a merged new failure under `OMP_SQUAD_REGRESSION_GATE=1` in a real temp repo. |
| 04 | 02 | Env flag name, default-off behavior, and failure semantics are final in `src/land.ts`. |

## Shared-file analysis

- `src/land.ts` is shared by 01 and 02. Run 01 first; 02 extends the same functions rather than parallel-editing the file.
- `tests/land-regression-gate.test.ts` may hold both direct land integration and default-off cases; 02 owns the file, 03 may append only orchestrator-specific assertions if still needed.
- `tests/land-autoresolve.test.ts` belongs to 02 because auto-resolve uses the same post-merge gate helper.
- Docs in 04 should not change code or tests.

## Verification posture

- Concern-level: narrow Bun tests for the new pure decision and real-git land path.
- Final required gate: `bun run check && bun test`.
- Do not run `dev` or `build`.

## Plane tracking

- Module: [Regression Gate](https://app.plane.so/inkwell-finance/projects/1eb181ba-f324-4767-a6d5-98953d5df011/modules/e3bc01ac-16d9-461d-9e9c-2dd231e0c8bd/)
- Issues:
  - [01-regression-decision-core](https://app.plane.so/inkwell-finance/browse/OMPSQ-399/) — OMPSQ-399 ✅ done (commit c39de16)
  - [02-merged-result-gate-integration](https://app.plane.so/inkwell-finance/browse/OMPSQ-400/) — OMPSQ-400
  - [03-orchestrator-path-coverage](https://app.plane.so/inkwell-finance/browse/OMPSQ-401/) — OMPSQ-401
  - [04-operator-docs-final-verification](https://app.plane.so/inkwell-finance/browse/OMPSQ-402/) — OMPSQ-402