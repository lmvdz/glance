# Per-lane enforcement flips: cost-gate enforce + model-route apply
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/cost-gate.ts, src/squad-manager.ts, src/model-route.ts, tests/cost-gate.test.ts, tests/model-route.test.ts
BLOCKED_BY: 01, 08

## Goal
The cost gate's `enforce` mode does what it says (chore lane first), and model routing can flip from shadow to apply per lane — turning a month of dashboard data into control signals, with every shadow mode owning a named exit.

## Approach
- Cost gate: implement real `enforce` semantics in `costGateMode()`'s consumer path — `costGateVerdict` gains a `lane` parameter resolving `LANE_POLICY[lane].costCeilingUsd`/`costAction` (falling back to the global `OMP_SQUAD_COST_MAX_PER_CHANGE`); at the squad-manager wiring (:4276, currently fire-and-forget `shadowCostCheck`), an enforce-mode `deny` refuses the spawn with the verdict line (surface as a create error + attention event), `ask` stages a confirm (reuse the landConfirm-style one-tap pattern). Rollout: only `chore` has `costAction: "deny"` in constants v1; hotfix/feature stay `"shadow"`/`"ask"` — spending more on a hotfix is sometimes correct, which is where this deliberately diverges from the source framework's static prescription.
- Model route: at the call site (squad-manager.ts:4310-4333), `LANE_POLICY[lane].modelRouteApply` joins the global `OMP_SQUAD_MODEL_ROUTE_SHADOW` check (apply requires BOTH the lane flag and the global not forcing shadow). Per-lane `minEdge` override passes through `routeModelForTaskClass`'s existing opts (src/model-route.ts:62). One deliberate note (red-team M2): those opts are documented as test seams — this concern re-documents them as operator-policy seams, in the module doc, so the repurposing is on the record; the shared MIN_EDGE evidence floor still applies wherever no lane override exists.
- Config posture (red-team S1): lane constants are code, so the fail-soft env-JSON hazard is gone by construction (concern 01 decision); the only env inputs here are the existing cost-gate vars — validate them loudly at boot (`glance doctor` line when `OMP_SQUAD_COST_GATE=enforce` but the aggregate is missing/thin).
- **Shadow exits** (red-team: shadow-forever is the observed outcome — the model-outcomes ledger sat empty for a month): add a scoreboard/factory-status row aggregating (a) lane classification counts, (b) shadow model-route decisions that WOULD have escalated, (c) shadow cost verdicts that WOULD have asked/denied — one place the operator reads before flipping. Each flip remains an operator action; this concern's definition of done includes the surface existing, not the flips being made.

## Cross-Repo Side Effects
Webapp: the scoreboard row renders in the existing usage/attribution panel — small additive change, included here.

## Verify
- `bun test tests/cost-gate.test.ts tests/model-route.test.ts` — enforce deny refuses spawn for chore over ceiling with sufficient lane-keyed sample; falls silent below min-sample; hotfix never denies v1; apply-mode requires lane flag AND global.
- Scratch daemon with `OMP_SQUAD_COST_GATE=enforce` + seeded aggregate: chore-lane spawn over ceiling refused with verdict line visible in UI attention; feature-lane spawn unaffected. Status surface shows the three shadow counters.

## Resolution
Shipped on branch worktree-research-adw-software-factory (PR #183), merged as a9973fd with integration/audit follow-ups on the same branch (see EXECUTION-LOG.md). real enforce (deny refuses spawn, ask stages attention confirm) + per-lane model-route apply (OR-widening, operator-sourced only) + shadow-exit scoreboard + doctor check; post-audit: deny requires an AGGREGATE-sourced projection (legacy downgrades to ask, code-review [3]/audit F3), gate judges the post-route model, restore/adopt paths exempt (code-review [5]), doctor wired to costGateAggregateReady (audit F2).
