# Epic 7 — Convergence loop (capstone)
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: .claude/settings (Stop hook), src/convergence.ts (new), scripts/continue-loop.sh (new), src/orchestrator.ts, src/planner.ts (Epic 1), src/validator.ts (Epic 3)
SUBPLAN: plans/meta-autonomous-fleet/epic-7-convergence-loop/

## Goal

The never-ending, cache-warm, self-verifying loop: `plan-against-verified-state → implement → independently-validate → ratchet-gate → escalate-on-low-confidence`, iterating a fixed meta-goal until the gap closes — driven so the agent auto-continues when it would otherwise stop, without re-reading its whole context uncached each cycle.

## Approach

This is fixpoint iteration, and it only converges if it's a contraction: each step must provably get closer and never undo a verified gain. That requires three wraps, which is why this epic is **blocked by 1, 2, 3, 5, 6**:

- **Independent oracle (Epic 3).** "What's left" is a diff against a fixed, checkable acceptance spec scored by the *independent* validator — never STATUS or green tests. A loop around a self-grader amplifies lies faster with a warm cache.
- **Ratchet (Epic 3/6 + existing `OMP_SQUAD_REGRESSION_GATE`).** Iteration N+1 is forbidden from destroying N's verified gains — the regression gate is the monotonicity guarantee.
- **Confidence exit (Epic 5).** Below threshold → stop and hand to the human as a proposal (report primitive), not grind. Above budget → hard stop.

**Drive mechanism — Stop hook, not cron.** Interval loops (`/loop`, `ScheduleWakeup`) re-read the entire conversation uncached every fire (≈5-min prompt-cache TTL) and discard warm working state. Instead, a **`Stop` hook** denies the turn-end and re-injects a continuation prompt so the same session keeps going cache-warm. It must consult a **verified-state oracle** before re-injecting: continue only if `gap > ε AND no low-confidence escalation pending AND budget remaining`; otherwise let the session stop. Guards: arm-gated (a sentinel/`OMP_SQUAD_LOOP_ARMED`, never global — a global Stop hook would make every session immortal), `stop_hook_active`-aware, hard token cap, and **session handoff** at context-window pressure (long warm sessions chained by a compact verified-state doc, not one immortal session).

## Decomposition seed (candidate leaves for the sub-plan)

- New `src/convergence.ts`: the iteration state machine over planner (Epic 1) + validator (Epic 3) + ratchet, emitting a `gap` + `verified-state` artifact each cycle; unit-tested on a converging and a diverging fixture.
- Verified-state oracle file the Stop hook reads (gap, pending-escalation, budget-remaining).
- `scripts/continue-loop.sh` Stop hook: arm-gated, budget-capped, `stop_hook_active`-aware; emits the block-and-continue decision or exits clean.
- Arming/disarming: sentinel set when a convergence run starts, cleared when the oracle says done or a confidence escalation fires.
- Session-handoff at context pressure: serialize verified-state → seed a fresh session.
- Ratchet integration: wire `OMP_SQUAD_REGRESSION_GATE` as the per-iteration no-regression guarantee.

## Verify

Arm the loop on a small fixture meta-goal with a checkable acceptance spec; confirm it iterates without human re-prompting, that each cycle's cache is warm (no full-context reload between iterations), that it stops when the gap closes, that a forced low-confidence iteration escalates to a human proposal instead of continuing, and that a regression introduced mid-loop is caught by the ratchet and not landed. Confirm the arming sentinel prevents any non-loop session from being auto-continued.
