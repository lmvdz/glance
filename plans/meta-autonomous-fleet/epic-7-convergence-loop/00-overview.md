# Epic 7 — Convergence loop (sub-plan overview)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
PARENT: plans/meta-autonomous-fleet/07-convergence-loop.md

## Outcome

A never-ending, cache-warm, self-verifying loop that iterates a fixed meta-goal until its
gap closes: `plan-against-verified-state → implement → independently-validate → ratchet-gate
→ escalate-on-low-confidence`. The loop is driven by a **Claude Code `Stop` hook** that denies
turn-end and re-injects a continuation prompt (so the same session stays prompt-cache-warm),
gated on a **verified-state oracle** file the hook consults each turn. It continues only while
`gap > ε AND no low-confidence escalation pending AND budget remaining`; otherwise it lets the
session stop. Arm-gated (never global), `stop_hook_active`-aware, hard token/turn cap.

This epic is the capstone. It is blocked by Epics 1 (planner), 2 (roles), 3 (validator),
5 (confidence exit), 6 (learning). It consumes those via **injected deps** (the orchestrator.ts
pattern), so every leaf here is buildable and unit-testable *now* against fakes, and the real
`src/planner.ts` / `src/validator.ts` wiring is a one-import adapter once those modules land.

## Work

| # | Concern | Complexity | Leaf | Touches |
|---|---|---|---|---|
| 01 | Verified-state oracle module | mechanical | yes | `src/convergence-oracle.ts` (new), `src/types.ts` |
| 02 | Convergence state machine | architectural | yes | `src/convergence.ts` (new), `src/convergence-oracle.ts`, `src/types.ts` |
| 03 | Ratchet dep (no-regression) | mechanical | yes | `src/convergence-ratchet.ts` (new), `src/land.ts` (reuse) |
| 04 | Stop-hook driver script | architectural | yes | `scripts/continue-loop.sh` (new) |
| 05 | Run entrypoint + settings + flag | mechanical | yes | `src/convergence-run.ts` (new), `.claude/settings.json` (new), `src/runtime-settings.ts` |
| 06 | Session handoff at context pressure | architectural | **no (branch)** | `src/convergence-oracle.ts`, `scripts/continue-loop.sh`, `src/convergence-run.ts` |

## Batch order

| Batch | Concerns | Why together |
|---|---|---|
| A | 01 | The oracle file contract (schema + paths + arm sentinel) that both the state machine (writer) and the hook (reader) bind to. Everything downstream depends on it. |
| B | 02, 03, 04 | All depend only on 01 and are independent of each other: 02 is the TS state machine, 03 the ratchet dep it consumes, 04 the bash hook that reads the oracle. Buildable in parallel. |
| C | 05 | Ties 02+03+04 together: the entrypoint that arms the sentinel, wires the real (Epic 1/3) deps via adapter, and installs the Stop hook into `.claude/settings.json`. |
| D | 06 | Context-pressure handoff — deferred: needs a deeper sub-plan (see flag). |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 oracle | — | `grep -n "resolveStateDir" src/state-dir.ts` (canonical state root the oracle lives under) |
| 02 state machine | 01 | `test -f src/convergence-oracle.ts && grep -n "writeOracle\|VerifiedState" src/convergence-oracle.ts` |
| 03 ratchet | 01 | `grep -n "export function decideRegressionGate\|export function extractGateFailures" src/land.ts` (both exported; reuse them) |
| 04 hook | 01 | `grep -n "oraclePath\|armPath" src/convergence-oracle.ts` (the path convention the bash mirrors) |
| 05 entrypoint | 02, 03, 04 | `test -f src/convergence.ts && test -f scripts/continue-loop.sh` |
| 06 handoff | 05 | `grep -n "handoff\|handoffDoc" src/convergence-oracle.ts` |

## Notes

- **Injected-deps decoupling is the whole trick.** `src/convergence.ts` never imports
  `planner.ts`/`validator.ts` directly — it takes `plan`, `dispatch`, `validate`, `ratchet`
  as a `ConvergenceDeps` interface (mirroring `OrchestratorDeps` in `src/orchestrator.ts:24`).
  That is what lets this epic ship its leaves before Epics 1/3 finish, and lets the acceptance
  tests run headless against fakes.
- **Two independent arm gates, both required** (belt-and-suspenders against an immortal
  session): a sentinel FILE under `<stateDir>/convergence/armed` AND `OMP_SQUAD_LOOP_ARMED=1`.
  A global Stop hook with either gate missing must be a clean no-op.
- The hook is **project-scoped** in `.claude/settings.json` (committed), not the user's global
  settings — a global Stop hook would make every unrelated Claude session immortal.

## Completion note (2026-07-05)

Leaves 01-05 shipped: `src/convergence-oracle.ts`, `src/convergence.ts`, `src/convergence-ratchet.ts`,
`scripts/continue-loop.sh`, `src/convergence-run.ts` + `.claude/settings.json` + the
`OMP_SQUAD_LOOP_ARMED` flag — 37 new tests, all green, zero regressions (server suite 1457→1494,
webapp untouched at 529). Real `plan`/`validate` wire to the now-landed Epic 1
(`planner.ts`/`features.ts`/`plan-writer.ts`) and Epic 3 (`validator.ts`); real `dispatch` is a
documented no-op (the live driving session does the work between Stop-hook turns, not this
process); real `validate`'s ratchet-facing `failures` is deliberately left empty rather than wired
to unmet acceptance criteria (see `src/convergence-run.ts`'s doc comment — conflating the two would
escalate every fresh multi-criterion goal on iteration 1). Leaf 06 (session handoff) stays
`STATUS: blocked` exactly as designed — it was flagged `ISLEAF: false` from the start and needs its
own sub-plan before implementation.
