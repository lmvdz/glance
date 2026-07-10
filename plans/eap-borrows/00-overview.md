# EAP borrows

## Outcome
- The fleet-learning matrix couples tokens+cost+success honestly (publish-gated), so G4's router
  reads a table that can't lie; oversized gate/diff output is never silently lost; harness
  capability claims are tiered honestly; five fail-open checkers fail closed now and ten more
  right after G3; membrane prompt disciplines exist measured and auto-reverting, default-off.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 accounting-core | success-coupled efficiency cells + publish gate + auto-champion baseline | architectural | omp-graph/task-class-matrix.ts, omp-graph/attribution.ts, model-route.ts, attribution-scoreboard.ts |
| 02 efficiency-flags | delivery-confirmed efficiencyFlags on receipts (measurement substrate for 05) | mechanical | types.ts, receipts.ts, squad-manager.ts (spawn path) |
| 03 gate-log-offload | lossless full-output logs + diff-aware budgeted excerpts in the validator | architectural | src/gate-logs.ts (new), validator.ts, types.ts |
| 04 fail-closed-wave-1 | classifyProbeFailure + the 5 findings that cannot refuse a land | architectural | land-risk.ts, observer.ts, proof.ts, convergence-run.ts, convergence-oracle.ts, attention lane |
| 05 membrane-disciplines | verdict-first + minimal-code blocks for judges/planner; unit tokens native-only, breaker | architectural | validator.ts, agent-profiles.ts, planner.ts, runtime-settings.ts |
| 06 harness-honesty-tiers | harnessTierInfo + usage-verified bit + API/CLI surface | mechanical | harness-registry.ts, server.ts, tui.ts |
| 07 fail-closed-wave-2 | the 10 land-path findings + land-path offload, post-G3 | architectural | land.ts, land-pr.ts, done-proof.ts, intake.ts, squad-manager.ts |
| 08 reproducible-eval-set | fixed re-runnable eval set behind "reproducible-or-unpublished" | research | (deferred — scoped only) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 03, 04, 06 | disjoint files, no G3 overlap, no cross-deps |
| 2 | 02, 05 | 05 consumes 02's flags; 02's spawn-path edit coordinated with live branch |
| 3 | 07 | gated on fix/one-green-loop merging |
| — | 08 | deferred, scope-only |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | — | squad-manager spawn region clean vs live branch: `git diff origin/main...fix/one-green-loop -- src/squad-manager.ts | grep '^@@'` |
| 03 | — | — |
| 04 | — | — |
| 05 | 02 | efficiencyFlags field exists on RunReceipt in types.ts |
| 06 | — | grok registered in harness-registry.ts on the branch being built on (`grep xai src/harness-registry.ts`) |
| 07 | G3 merge | `git branch --merged origin/main | grep fix/one-green-loop` (or the branch's PR shows MERGED) |
| 08 | 01 | CellMetrics.reproducible exists |

## Notes
- Origin: /research EAP → BRIEF PR #148 → user "act on it". Gates run as recorded checkpoints
  (research→plan chain); execution NOT auto-started — mode and timing are the user's call.
- WIP-check 2026-07-09: 35 real plan dirs; the scanner reported 1,401 because 91 git worktrees
  each carry a plans/ copy — scanner should learn to skip worktrees (candidate quick fix).
  Proceeded on the user's explicit "act on it".
- Live branch at plan time: fix/one-green-loop (G3), touching land-mode.ts, land-pr.ts,
  squad-manager.ts. Batch 3 waits for it; 02 coordinates around it.
- grok/xai harness registration lives on feat/grok-harness — merge order matters for 06.
- Adjudicated grok sweep report preserved at plans/eap-borrows/failopen-sweep.md.
- Borrow #6 (per-hop SSRF) closed pre-plan: gap already documented in ssrf.ts header; fix blocked
  on the omp/browser producer.
