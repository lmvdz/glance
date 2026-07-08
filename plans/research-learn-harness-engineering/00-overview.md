# Harness-engineering gaps (from learn-harness-engineering research)

## Outcome
- Dispatched fleet units receive their **authored spec** (concern/Tier-2 body), not just a title — the
  single confirmed capability leak found by adversarial design.
- The land-gate runs as **ordered fail-fast stages** with per-stage receipts, so a failure says *which*
  stage (typecheck vs test) failed and stops at the first red one.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 | Fleet units are dispatched title-only; their authored spec is discarded (`IssueRef` has no body) | architectural | src/types.ts, src/squad-manager.ts, src/fabric-search.ts (fence reuse), tests |
| 02 | The land-gate is one opaque `&&`-joined command; failures don't say which check failed | mechanical | src/intake.ts, src/proof.ts, src/gate-runner.ts (or types), tests |
| 03 | Pre-dispatch harness scorecard (advisory shadow) | architectural | src/harness-scorecard.ts (new), src/types.ts, src/squad-manager.ts, src/dispatch.ts, webapp/src/lib/dto.ts, webapp/src/lib/insights.ts, tests |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Highest value; fixes the root defect; unblocks 03's signal |
| 2 | 02 | Independent (gate/proof path); no overlap with 01 |
| 3 | 03 | Built once 01 shipped (it did) — see the concern doc for how the other two deferral reasons (hook split, alert-fatigue) were resolved without deferring further |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | `grep -n "task = " src/squad-manager.ts` shows title-only dispatchSpawn |
| 02 | — | `grep -n 'join(" && ")' src/intake.ts` shows the joined gate string |
| 03 | 01 (soft) | 01 fixes the "instructions" red signal 03 would score |

## Status
- **3/3 concerns shipped** (01 + 02 landed earlier; 03 in review — see its concern doc for the
  post-deferral build). Gaps 1B, 2, 4 dropped with verified rationale (DESIGN.md). 03's own suite:
  root `bun test` 2036 pass / 0 fail (up from a 2010-pass baseline), webapp `bun test` 582 pass / 0
  fail; root + webapp `tsc --noEmit` clean.

## Notes
- **Headless /plan run**: proceeded over 127 plans with open concerns (Plane-side 389; doc-side ~23);
  oldest `meta-plan-autonomous-fleet` at 2026-07-05. Debt logged, not hidden.
- **Scope was cut by adversarial design**: gap 1B (E2E vision gating), gap 2 (ledger consolidation),
  gap 4 (cleanup fleet) were DROPPED with verified rationale — see DESIGN.md. Research asked for 4
  gaps; 2 real + 1 deferred survived. This is the intended function of the research→plan→red-team
  pipeline (kill near-no-ops before code).
- Build-vs-buy: borrow patterns throughout; source is MIT curriculum content, not a dependency.
