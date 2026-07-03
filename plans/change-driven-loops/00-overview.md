# Change-driven, auditable background loops

## Outcome
- The Observer stops re-running the full `bun test`/`tsc` suite every 60s on an idle
  fleet — it runs only when the working tree it tests actually changed. (#1)
- The dashboard can tell a healthy-idle loop ("nothing changed") from a wedged one,
  because every loop emits a "ticked, did nothing, here's why" receipt. (#2)
- Malformed plan graphs (cycles, dangling deps) surface as warnings before they're
  acted on, instead of being silently swallowed. (#4)
- Agent scope becomes a real contract: a unit declares what it `requires` and
  `produces`; conflicts warn (or block, when an operator declares them), dispatch
  defers a unit whose reads aren't yet produced, and post-run writes outside scope are
  flagged — sourced from the git branch diff, not the unreliable receipt. (#3)

## Work
| # | Concern | Why it exists | Pattern | Complexity | Touches |
|---|---------|---------------|---------|------------|---------|
| 01 | Skip-event foundation | `skipReason` field + transition-spool so skips persist without flooding | #2 | mechanical | types.ts, automation-log.ts |
| 02 | Digest idle-vs-stuck | Teach `automationDigest` to flag wedged loops via existing `lastAt` | #2 | architectural | webapp insights.ts (+test) |
| 03 | Loops emit skip reasons | Each loop names why a no-op tick did nothing (liveness) | #2 | architectural | scout/opportunity/orchestrator/dispatch.ts |
| 04 | Observer gate fingerprint | Gate the costly suite on a working-tree hash, inside the land-lock | #1 | architectural | squad-manager.ts |
| 05 | Plan-DAG validator | Detect cycles + unresolved deps on the canonical edge map | #4 | architectural | webapp planGraph.ts (+test) |
| 06 | Validation surfacing | UI banner + skill pre-flight, no duplicated validator | #4 | architectural | PlanFlowDiagram/TaskDetail, features.ts, 3 skills |
| 07 | Scope contract types + planner | `requires`/`produces` on Owner/DTO + planner emission + provenance | #3 | architectural | ownership.ts, smart-spawn.ts, types.ts |
| 08 | Spawn check + produces audit | Enforce requires at spawn; audit produces vs **git diff** | #3 | architectural | squad-manager.ts |
| 09 | Requires → dispatch gate | Make the contract gate ordering, with a deadlock guard | #3 | architectural | dispatch.ts |
| 10 | Operator-declared scope UI | Operator entry point so the enforced paths actually fire | #3 | architectural | webapp spawn form, src/web, types.ts |

## Order
| Batch | Concerns | Why together |
|-------|----------|--------------|
| 1 | **01**, **05** | Two independent foundations (ledger field; pure validator) — different files, fully parallel |
| 2 | **02**, **03**, **04**, **06**, **07** | All depend only on batch 1; disjoint file sets (webapp insights / the 4 loops / squad-manager / webapp+features+skills / ownership+smart-spawn+types) |
| 3 | **08**, **09**, **10** | The #3 enforcement layer — each lands *after* a batch-2 concern that shares its file (08←04 squad-manager, 09←03 dispatch, 10←07 types) |

## Dependency graph
| Concern | Blocked by | 30s check (VERIFY_BLOCKER) |
|---------|-----------|----------------------------|
| 02 | 01 | `grep -n "skipReason" src/types.ts` returns the field |
| 03 | 01 | `grep -n "recordSkip" src/automation-log.ts` exists |
| 04 | 01 | `recordSkip` available on the Observer recorder |
| 06 | 05 | `grep -n "validatePlanGraph" webapp/src/lib/planGraph.ts` exported |
| 07 | 01 | types.ts AutomationEvent edit already landed (avoid same-file merge) |
| 08 | 04, 07 | squad-manager gate edit landed; DTO carries `requires`/`produces`/`scopeSource` |
| 09 | 03, 07 | dispatch skip-reason edit landed; DTO carries the contract fields |
| 10 | 07 | `CreateAgentOptions` carries `requires`/`produces` |

## Shared-file analysis (SAME-FILE rule)
| File | Concerns | Resolution |
|------|----------|------------|
| `src/types.ts` | 01, 07, 10 | Different interfaces (`AutomationEvent` vs scope fields); 01 lands batch 1, 07 batch 2, 10 batch 3 — strictly sequential, no concurrent edit |
| `src/squad-manager.ts` | 04, 08 | 04 (gate) batch 2, 08 (audit) batch 3 — sequential; 08 gets a PRIOR-CHANGES summary of 04 |
| `src/dispatch.ts` | 03, 09 | 03 (skip reason) batch 2, 09 (requires gate) batch 3 — sequential |
| `src/orchestrator.ts` | 03 | single concern |
| `webapp planGraph.ts` | 05, (06 imports) | 05 defines, 06 consumes — sequential |

No two concerns in the same batch share a file. The #3 enforcement concerns (08/09/10)
are deliberately held to batch 3 because each extends a file a batch-2 concern creates
the contract in.

## Notes
- **Estimated batches: 3.** Batch 1 (2 concerns), batch 2 (5), batch 3 (3).
- Load-bearing ordering: #2 vocabulary (01) before #1 gate (04) so the gate's skip is
  observable; #3 types (07) before its three enforcement concerns.
- Build-vs-buy: every pattern is **borrowed**, no external dependency added. The design
  pass explicitly rejected adopting `@openprose/reactor`.
- #3 is the full version (user override of the cut recommendation). Its correctness
  hinges on three red-team fixes baked into the concerns: produces audit sourced from
  **git branch diff** not `RunReceipt.filesTouched` (08); `requires` wired into the
  **dispatch admission gate** (09); contracts **operator-declarable** so enforcement
  fires (10). Without these three, #3 is the noise version both red teams warned about.
- The two minor design defaults (stuck threshold ≈3× interval; force-run every 10th
  tick) are encoded in concerns 02 and 04 respectively.

## Plane tracking
- Module: [Change-driven background loops](https://app.plane.so/inkwell-finance/projects/1eb181ba-f324-4767-a6d5-98953d5df011/modules/d69f8a19-d921-4f0d-bab4-4aaf9628d757/)
- Issues:
  - [01-skip-event-foundation](https://app.plane.so/inkwell-finance/browse/OMPSQ-339/) — OMPSQ-339 (Todo)
  - [02-automation-digest-idle-vs-stuck](https://app.plane.so/inkwell-finance/browse/OMPSQ-340/) — OMPSQ-340 (Backlog ← 339)
  - [03-loops-emit-skip-reasons](https://app.plane.so/inkwell-finance/browse/OMPSQ-341/) — OMPSQ-341 (Backlog ← 339)
  - [04-observer-gate-fingerprint](https://app.plane.so/inkwell-finance/browse/OMPSQ-342/) — OMPSQ-342 (Backlog ← 339)
  - [05-plan-dag-validator](https://app.plane.so/inkwell-finance/browse/OMPSQ-343/) — OMPSQ-343 (Todo)
  - [06-plan-validation-surfacing](https://app.plane.so/inkwell-finance/browse/OMPSQ-344/) — OMPSQ-344 (Backlog ← 343)
  - [07-scope-contract-types-and-planner](https://app.plane.so/inkwell-finance/browse/OMPSQ-345/) — OMPSQ-345 (Backlog ← 339)
  - [08-spawn-validation-and-produces-audit](https://app.plane.so/inkwell-finance/browse/OMPSQ-346/) — OMPSQ-346 (Backlog ← 342, 345)
  - [09-requires-dispatch-gate](https://app.plane.so/inkwell-finance/browse/OMPSQ-347/) — OMPSQ-347 (Backlog ← 341, 345)
  - [10-operator-declared-scope-ui](https://app.plane.so/inkwell-finance/browse/OMPSQ-348/) — OMPSQ-348 (Backlog ← 345)
