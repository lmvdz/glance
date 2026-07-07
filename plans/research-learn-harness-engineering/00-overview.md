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
| 03 | Pre-dispatch harness scorecard (advisory shadow) — DEFERRED, write only | architectural | (deferred) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Highest value; fixes the root defect; unblocks 03's signal |
| 2 | 02 | Independent (gate/proof path); no overlap with 01 |
| — | 03 | Deferred — `open`, not built this pass |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | `grep -n "task = " src/squad-manager.ts` shows title-only dispatchSpawn |
| 02 | — | `grep -n 'join(" && ")' src/intake.ts` shows the joined gate string |
| 03 | 01 (soft) | 01 fixes the "instructions" red signal 03 would score |

## Status
- **2/3 concerns closed** (01 + 02 shipped). 03 deferred (`open`) by design — see DESIGN.md. Gaps 1B,
  2, 4 dropped with verified rationale. Full suite: 1825 pass; the only 3 failures are pre-existing
  effect-ratchet baseline drift (`json-parse-as-cast`/`bool-env-compare`/`error-message-idiom`) whose
  hits are all in files this change never touched — diff adds zero ratcheted idioms.

## Notes
- **Headless /plan run**: proceeded over 127 plans with open concerns (Plane-side 389; doc-side ~23);
  oldest `meta-plan-autonomous-fleet` at 2026-07-05. Debt logged, not hidden.
- **Scope was cut by adversarial design**: gap 1B (E2E vision gating), gap 2 (ledger consolidation),
  gap 4 (cleanup fleet) were DROPPED with verified rationale — see DESIGN.md. Research asked for 4
  gaps; 2 real + 1 deferred survived. This is the intended function of the research→plan→red-team
  pipeline (kill near-no-ops before code).
- Build-vs-buy: borrow patterns throughout; source is MIT curriculum content, not a dependency.
