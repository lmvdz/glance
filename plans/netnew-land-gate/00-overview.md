# Overview: base-aware land gate

Origin: `/research vyuh-labs/dxkit` → `/plan`. dxkit's transferable concept (a worse-than-baseline
acceptance gate) was applied to omp-squad after adversarial design **rejected adopting dxkit
itself** (see DESIGN.md). Net result: a ~20-line, zero-dependency change to the existing gate.

## Scope
| Concern | COMPLEXITY | TOUCHES | STATUS |
|---|---|---|---|
| 01-base-aware-gate | architectural | src/land.ts, tests/land-base-gate.test.ts, README.md | open |

## Dependencies
None — single concern. No BLOCKED_BY.

## Batch order
One unit, dispatched to the fleet (worktree-isolated, lands via proven merge).

## Deferred (not built — see DESIGN.md for rationale)
- "Didn't make a red repo *worse*" granularity (needs per-framework test-output parsing).
- Deterministic conflict-reviewer swap (RedTeamScope Slice A) — orthogonal; build on demonstrated need.
- Fleet-wide secrets gate — gitleaks-only if ever, not dxkit; belongs in target-repo CI.
- Base-aware logic for the `attemptAutoResolve` gate — optional follow-up.
