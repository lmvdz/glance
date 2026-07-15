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
- Sandbox-by-default for dispatched units / workflow-node containment — dispatched units are workflow-kind and `makeDriver` ignores `sandbox` for them (squad-manager.ts:4675 vs :4718); flipping defaults now would be a false-green containment claim. Belongs to the factory-control-plane concern 04 spike ("driver capabilities and proof runner boundary").
- Dispatch-level best-of-n racing (the BRIEF's concept 4b) — needs a ledger schema migration, judge, loser sweep, and an atomic land-claim; design spike, not a build concern.
- Lane-based dispatch preemption / `dispatchOrder` tiebreak — inert until preemption exists; classifier runs after ordering anyway.
- `docs` and `investigation` lanes — docs ≡ chore policy-wise; investigation ≡ existing ask-mode observer units.
- Promoter polling loop — measured trigger volume (~2 human-authored Backlog tickets/week, live Plane 2026-07-15) doesn't justify loop machinery; the one-shot covers it.

## Decisions so far
- (populated at execution close)

## Notes
- Headless research→plan pipeline run (2026-07-15): EXPLORE/DESIGN/DECOMPOSE gates auto-approved per skill gate policy; user authorized the chain with the research handoff. EXECUTE not started.
- Phase 0 WIP snapshot: proceeded over 290 plans with open work (scanner double-counts worktree copies; user pre-answered proceed via the research-gate confirmation).
- Design provenance: BRIEF at plans/research-adw-software-factory/BRIEF.md; adversarial round recorded in DESIGN.md. Both red teams verified findings against source at main @ 5b0a2d1.
- Concern 03 is a behavioral migration (Backlog stops auto-dispatching once flipped); it ships flag-gated with the default flip as an explicit operator step documented in the concern.
- Not filed to Plane yet — decomposition reshaped materially during review; file via /plan-to-plane after the human reads this overview.
