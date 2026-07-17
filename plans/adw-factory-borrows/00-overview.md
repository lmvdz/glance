# ADW software-factory borrows

## Outcome
- Work gets a typed lane (hotfix/feature/chore) that model routing and cost gating key on, with clamped precedence so ticket text can never buy privilege.
- Plane's Backlog becomes a real holding pen: the dispatcher only pulls released states, and a one-shot `glance promote` authors Tier-2 enrichment a human releases with a drag to Todo.
- The last unsandboxed executor of agent-authored code (`validate.ts`) routes through the shipped gate container.
- A unit that exhausts its verify workflow gets one fresh-context alternate-strategy attempt before parking on a human.
- Cost gating gains a real enforce mode (chore lane first) on lane-keyed evidence; model routing can flip to apply per lane.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 lane core | Shared routing key + classifier + clamped policy constants | architectural | src/lane.ts (new), src/intake.ts |
| 02 lane threading | Lane must ride the unit end-to-end to be usable | mechanical | src/types.ts, src/plane.ts, src/squad-manager.ts |
| 03 dispatcher state gate | Backlog is dispatch-eligible today; promotion needs a holding pen | mechanical | src/dispatch.ts, src/config.ts |
| 04 plane write primitives | Promoter needs body-edit + safe named-state move | mechanical | src/plane.ts |
| 05 promote one-shot | Automate Tier-1/Tier-2 enrichment, keep human release | architectural | src/promote.ts (new), src/index.ts, src/server.ts, webapp |
| 06 validate.ts via gateExec | Last unsandboxed executor; closes OMPSQ-160 | architectural | src/validate.ts, src/gate-runner.ts |
| 07 race-once on catastrophe | One autonomous rung before human parking | architectural | src/squad-manager.ts, src/race-ledger.ts (new) |
| 08 lane-keyed cost aggregate | O(1) enforce-safe projection; lane-blind data denies wrongly | architectural | src/receipts.ts, src/cost-aggregate.ts (new), src/cost-gate.ts |
| 09 per-lane enforcement flips | Dashboard → control signal, evidence-gated | mechanical | src/cost-gate.ts, src/squad-manager.ts, src/model-route.ts |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 03, 04, 06 | Zero mutual dependencies; 06 is the standing security gap, land first |
| 2 | 02, 05 | 02 needs 01; 05 needs 03+04 |
| 3 | 07, 08 | 07 needs lane on the unit (01+02); 08 needs lane on receipts (02) |
| 4 | 09 | Needs 01+08 |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | `grep -n "WorkLane" src/lane.ts` returns the union |
| 05 | 03, 04 | `grep -n "dispatchStates\|releasableStates" src/dispatch.ts` hits; `grep -n "updatePlaneIssueBody" src/plane.ts` hits |
| 07 | 01, 02 | `grep -n "lane" src/types.ts` shows CreateAgentOptions.lane + AgentDTO.lane |
| 08 | 02 | `grep -n "lane" src/receipts.ts` shows lane on RunReceipt |
| 09 | 01, 08 | `grep -n "readCostAggregate\|costAggregate" src/cost-gate.ts` hits |

## Not yet specified
- (none)

## Out of scope
- Policy-store lane override (concern 01's "operator override seam") — deliberately not built this wave; operator lanes reach production via `glance add --lane` and POST /api/spawn `lane` instead (audit F1 fix). Extend `src/policy.ts`'s dispatch seam with `lane` if per-rule overrides are ever needed.
- `glance doctor` line for the `OMP_SQUAD_DISPATCH_STATES` migration flip — .env.example documents it; a doctor fact needs AutonomyFacts plumbing disproportionate to the nudge.
- Web "Start task" path label-lane asymmetry — it never fetches issue detail, so a `lane:*`-labeled ticket started by hand gets classifier lane only; acceptable (a human is present and can pass an operator lane once the UI exposes it).
- `gateRunUnrunnable` classification for validate.ts's gate calls — a dead docker reads as a check FAIL, not an environment failure; fail-closed, follow-up quality item.
- Sandbox-by-default for dispatched units / workflow-node containment — dispatched units are workflow-kind and `makeDriver` ignores `sandbox` for them (squad-manager.ts:4675 vs :4718); flipping defaults now would be a false-green containment claim. Belongs to the factory-control-plane concern 04 spike ("driver capabilities and proof runner boundary").
- Dispatch-level best-of-n racing (the BRIEF's concept 4b) — needs a ledger schema migration, judge, loser sweep, and an atomic land-claim; design spike, not a build concern.
- Lane-based dispatch preemption / `dispatchOrder` tiebreak — inert until preemption exists; classifier runs after ordering anyway.
- `docs` and `investigation` lanes — docs ≡ chore policy-wise; investigation ≡ existing ask-mode observer units.
- Promoter polling loop — measured trigger volume (~2 human-authored Backlog tickets/week, live Plane 2026-07-15) doesn't justify loop machinery; the one-shot covers it.

## Decisions so far
- [01 lane core](01-lane-core.md) — 3-lane closed union, hard constants, classifier shadow-first; policy-store seam deferred (see Out of scope)
- [02 lane threading](02-lane-threading.md) — Plane-label transport, laneSource persisted so restarts can't upgrade privilege; clamp binds to lane-derived router params, never the global apply flag
- [03 dispatcher state gate](03-dispatcher-state-gate.md) — five-group-only, case-normalized, fail-closed when narrowed / fail-open at default; ledger stamped post-spawn
- [04 plane write primitives](04-plane-write-primitives.md) — hash-guarded body writes, named-state-or-no-write moves, multi-org refused
- [05 glance promote](05-promote-one-shot.md) — one-shot via ask(), truncation-aware fail-closed validation, original body preserved, release = human drag to Todo
- [06 validate via gateExec](06-validate-gateexec.md) — closes OMPSQ-160; argv-direct host fallback; explicit operator network hardening honored
- [07 race-once](07-race-once-catastrophe.md) — catastrophe seam only, human-sourced lanes only, park-or-don't-race, claim-then-spawn ledger
- [08 lane-keyed cost aggregate](08-lane-keyed-cost-aggregate.md) — (model,tier,lane) tumbling window + rollup; cells answer only when they can price a landed change
- [09 per-lane enforcement](09-per-lane-enforcement.md) — deny requires aggregate-sourced projection judged post-routing; shadow exits get a scoreboard + doctor check; flips stay operator actions

## Notes
- **Executed 2026-07-15/16: 9/9 concerns done** (4 workflow batches + integration fixes + a 2-audit Phase-5 round that found and fixed 11 code-review-confirmed defects and 5 cross-batch audit findings — see EXECUTION-LOG.md). All flags default off/shadow; the operator flip order is: OMP_SQUAD_DISPATCH_STATES=unstarted,started (holding pen) → promote tickets → read the shadow-exit scoreboard row → flip OMP_SQUAD_COST_GATE=enforce / lane apply flags / OMP_SQUAD_RACE_ONCE as evidence supports.
- Headless research→plan pipeline run (2026-07-15): EXPLORE/DESIGN/DECOMPOSE gates auto-approved per skill gate policy; user authorized the chain with the research handoff; EXECUTE authorized separately ("do it") and completed — see the line above.
- Phase 0 WIP snapshot: proceeded over 290 plans with open work (scanner double-counts worktree copies; user pre-answered proceed via the research-gate confirmation).
- Design provenance: BRIEF at plans/research-adw-software-factory/BRIEF.md; adversarial round recorded in DESIGN.md. Both red teams verified findings against source at main @ 5b0a2d1.
- Concern 03 is a behavioral migration (Backlog stops auto-dispatching once flipped); it ships flag-gated with the default flip as an explicit operator step documented in the concern.
- Not filed to Plane yet — decomposition reshaped materially during review; file via /plan-to-plane after the human reads this overview.
