# Execution log — adw-factory-borrows

Executed 2026-07-15/16 as four review-gated workflow batches (sonnet implementers in isolated worktrees, fable reviewer per batch, sonnet fixers, fable re-review), merged sequentially into `worktree-research-adw-software-factory` (PR #183) with composition fixes at each integration point. Full root suite + webapp suite green after every batch.

## Batch 1 — concerns 01, 03, 04, 06

| Concern | Model | Result | Review | Merged as |
|---|---|---|---|---|
| 01 lane core | sonnet | done | PASS (2 minor) | e5caedd |
| 03 dispatcher state gate | sonnet low | done | PASS (3 minor) | c837c6a |
| 04 plane write primitives | sonnet low | done | FAIL → fixed → PASS | f41d22c |
| 06 validate via gateExec | sonnet | done | FAIL → fixed → PASS | 7c8c675 |

Review criticals: 04/06 each failed the composed suite standalone (dead-exports ratchet +2; `OMP_SQUAD_ACCEPTANCE_GATE_NETWORK` missing from .env.example). Integration fixes (282f44b): state gate acts only on the five known Plane state groups (a degraded /states fetch leaves raw UUIDs — must fail open); `OMP_SQUAD_DISPATCH_STATES` documented; env-example scanner taught `envStringList`.

Notable implementer honesty: 06 found the concern's "lint" spawn anchor was wrong (lintWorker is pure filesystem — only two real spawn sites) and 01 correctly refused the out-of-TOUCHES policy-store override seam (the overview's Out of scope entry for it was only added at audit time — the audit caught this log's earlier claim that it already existed).

## Batch 2 — concerns 02, 05

| Concern | Model | Result | Review | Merged as |
|---|---|---|---|---|
| 02 lane threading | sonnet low | done | PASS (2 minor) | b176c7d |
| 05 glance promote | sonnet | done | FAIL → fixed → PASS | 373db2d |

Review critical (05): the promote HTTP route blocked up to `GLANCE_ASK_TIMEOUT_MS` (30 min) against Bun.serve's 120s idleTimeout — the socket died before the caller saw any result; fixed before merge. Integration fixes (bc0d455): the concern-02 clamp had overshot — it forced model-route shadow for every non-operator lane, silently killing the operator's global apply flag (the router decision takes no lane input yet, so the clamp belongs on concern 09's lane-derived params); lane + a new persisted `laneSource` restore verbatim across daemon restarts so a restart can't upgrade a classifier lane to operator privilege (four restore/adopt literals were dropping it).

## Batch 3 — concerns 07, 08

First attempt lost all three agents to a session usage limit; resumed clean.

| Concern | Model | Result | Review | Merged as |
|---|---|---|---|---|
| 07 race-once at catastrophe | sonnet | done | PASS (5 minor) | 15911a7 |
| 08 lane-keyed cost aggregate | sonnet | partial (by honesty) | PASS (3 minor) | c7d8c3f |

07's implementer caught and fixed a real TOCTOU in its own race guard (ledger check-then-write across the sibling's async create) via a synchronous `raceInFlight` claim. 08 correctly left two documented squad-manager wires outside its TOUCHES. Integration fixes (90edadb): race spend now requires a human-sourced lane (`laneSource` operator|label — a classifier hit on "urgent" in task text must not buy a second agent run); the race sibling inherits approvalMode + requires/owns/produces/scopeSource instead of hardcoding yolo and dropping scope; 08's two wires landed (`RunSeed.tier`, `recordCostLanded` in land()); the rebuild's all-time landed overlay clamps to windowed attempts (unclamped, landRate > 1 undercuts costPerLandedChange — fail-open once enforce reads it); json-parse-as-cast ratchet appeased with typed bindings.

## Batch 4 — concern 09

| Concern | Model | Result | Review | Merged as |
|---|---|---|---|---|
| 09 per-lane enforcement | sonnet | done | FAIL → fixed → PASS | a9973fd |

Review critical: the shadow-exit surface (scoreboard + webapp row) was omitted as out-of-TOUCHES, but it is the concern's definition-of-done — the fixer added `lane-classification`/`cost-gate-verdict` metrics, `deriveShadowExitScoreboard` in factory-status, the webapp FactoryStatusStrip row, a `glance doctor` enforce-armed-but-inert check, and real dispatch-level tests (enforce deny at the actual createWithId wiring). The implementer also found the concern's "apply requires BOTH lane flag AND global" prose contradicted concern 02's already-locked clamp contract and correctly re-derived OR-widening semantics (global flag = baseline; an operator-sourced lane can widen past a global shadow default). Integration fixes (e6be6d8): server.ts autonomyFacts populates `costGateMode`/`costAggregateReady` (the doctor check was dead against a live daemon); scoreboard metrics read with `limit: 0` (the 500-event default silently saturated); trace-cache FIFO test de-flaked (15s timeout — sat at the 5s edge under full-suite load, unrelated to this plan).

## Gates

Every batch: full root `bun test` green in the integration worktree before push (final: 3101 pass, 0 fail; the only suite error is the pre-existing ACP-driver teardown rejection, byte-identical code on origin/main). Webapp suite + both typechecks green after batches 2 and 4 (the webapp-touching batches). Known false-red patterns hit and handled: dead-exports ratchet composition headroom, env-example scanner blindness to new readers, load-induced trace-cache timeout.

## Audit round (Phase 5)

Two audits ran over the full diff after batch 4: a 31-agent workflow-backed /code-review at high effort (11 CONFIRMED findings) and a fable cross-batch audit (5 significant + 6 minor findings; wiring/invariant dimensions otherwise verified clean). Every confirmed finding was fixed on the branch (commits after e6be6d8):

- **Operator lanes were unreachable** (audit F1): no production caller could set `opts.lane` — every privilege axis was dead code. Fixed: `--lane` on `glance add` + `lane` on POST /api/spawn; the policy-store override seam is recorded as deliberately deferred in the overview.
- **Sandbox regressions in the validate.ts migration** (code-review [0]/[1]): the host fallback's `bash -lc` login shell re-imported profile-exported secrets past the deny-by-default env (fixed: argv-direct `hostArgv` host fallback), and the acceptance container's `bridge` default silently overrode an operator's explicit `OMP_SQUAD_GATE_SANDBOX_NETWORK=none` (fixed: explicit global wins over the default; the acceptance-scoped knob still wins over both).
- **Enforce-mode fail-open cluster**: zero-landed lane cells silenced verdicts instead of falling through ([2]); the gate judged the pre-route model and let routing swap in a frontier model afterwards ([3] — gate moved after model routing, keyed on the receipts' tier); a deny-throw permanently consumed the issue in the add-only dispatch ledger ([4] — ledger now stamped only after spawn resolves); restore/adopt/fork paths could be refused re-creation of live units ([5] — laneSource-carrying paths exempt); deny now requires an aggregate-sourced projection — the lane-blind legacy scan downgrades to ask (audit F3).
- **Race-once fail-opens** ([6]/[7]): a failed park no longer races (fail closed to escalation); the race ledger stamps claim-then-spawn with a pending→real refinement so a crash window can never re-arm the budget.
- **State gate** (audit F4 + [8]): unrecognized state values fail CLOSED under an operator-narrowed gate (open under the default), and config values are case-normalized.
- **Promote body clobber** (audit F5 + [9]): the original description is preserved under a tail heading (truncation can only cut the preserved original, never validated Tier-2) and the write is `expectHash`-guarded via a new raw-body reader.
- **Doctor readiness** (audit F2): `costAggregateReady` now wired to `costGateAggregateReady` (sample-floor semantics), not doc-parses; scoreboard reads unbounded (`limit: 0`).

Deliberately not done, recorded in the overview: the policy-store lane override, a doctor line for the `OMP_SQUAD_DISPATCH_STATES` migration flip, the web start-task path's label-lane asymmetry, and `gateRunUnrunnable` classification for validate.ts's gate calls.
