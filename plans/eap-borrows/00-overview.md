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

## Completion (2026-07-10)

7/8 concerns done (08 deferred by design — scope-only, gated on post-G3 volume).
Suite 2382 → **2519 pass / 0 fail**; tsc clean. Commits: e114228, 278e3f8, a2cbcc7, 5bffd28,
f107d58, 2615c33, e2039d3, aff5270, 07a10e6, 6840cb7, 50145f4, 4aaabe5, 703c61c.

**The audit gauntlet was load-bearing.** Per-batch reviews passed, the suite was green — and a
high-effort adversarial code review (31 candidates, 24 verifiers, 0 refuted) still found 10 real
defects, five of them the wave-2 fail-closed fixes *not actually failing closed*:
- the transplant gate fail-opened when `origin/<default>` was pruned (git emits byte-identical
  "unknown revision" text for a missing left ref and a missing branch);
- the observer's gate-unrunnable path was unreachable (production `runGate` never throws);
- the unproven-green classifier was defeated by check ordering, and absent entirely on the local path;
- two `merge-base` probes read exit-1 ("no common ancestor") as a spawn error → permanent refusal;
- the new `reproducible` gate silently disabled the live model router (champion compared to itself
  at a saturated mergeRate; cost-coverage floor gating merge-rate routing).

**Cross-lineage review then caught what the native re-verify missed.** grok-4.5, asked what the
fixes *opened* rather than whether the holes closed, found: `land-risk` returning "genuinely safe"
for an unknowable blast radius (fail-open, caused by this plan's own fixlist over-generalizing the
stale-gate discrimination); the transplant probe parking a branch permanently on a transient pruned
ref; and — verified in code — that `landFailureCount` is gated on `!result.retryable`, so retryable
refusals had **no bounded escalation whatsoever**, the exact 1,381-refusal interlock shape. All
fixed (`703c61c`), with `OMP_SQUAD_LAND_BLOCKED_ESCALATE_CAP` (default 20) now escalating a stuck
episode to the "Needs you" lane.

## Follow-ups (named, not silently dropped)
- `detectBaselineStaleness` + `pinnedModel` have no producer — decision 4 is 1/3 live (needs a
  persisted previous-baseline to be meaningful).
- `flagEfficiencyRegression` / `isCostReproducible` are substrate without a production caller —
  sanctioned by DESIGN's "schema-before-router (G4)" posture; wire when G4's ledger fills.
- `ValidationRecordDTO` lacks `gateLogPaths` (webapp mirror); extend when a renderer exists.
- `extractGateFailures` whole-output identity is nondeterminism-sensitive (interior timestamps);
  normalize per-line timing tokens if a real repo hits it.
- Stale-probe/merge TOCTOU (pre-existing): re-probe after a clean merge, or capture+compare base SHA
  under the repo land lock.
- Concern 05's live scratch-daemon smoke was waived in favor of FakeDriver assertions.
