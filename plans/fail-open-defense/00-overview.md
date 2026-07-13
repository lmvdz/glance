# Fail-open defense

## Outcome
- Every probe-backed gate is proven, generatively, never to return "allow" under a fault (git exit
  1/128, spawn death, empty stdout, timeout, disk full) — which regression-locks the 15 fail-closed
  fixes that just shipped and catches the *semantic* fail-opens no type can see.
- The `undefined`-means-allow mechanism is dead on the land path, and a ratchet keeps it dead.
- The live `aheadOfBase` fail-open — a git fault silently skipping a unit's land — is closed.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 fault-injection-harness | catches the ~5 semantic/ordering fail-opens the type cannot, and locks the 15 shipped fixes | architectural | tests/gate-fault-injection/, tests/helpers/git-fault.ts |
| 02 ahead-of-base-sentinel | LIVE fail-open: `-1` reads as "no unlanded work"; orchestrator skips the land | mechanical | src/land-mode.ts, src/squad-manager.ts, src/worktree-reaper.ts |
| 03 split-gate-run-unrunnable | its `undefined` means three different things; any fold turns a real red into an allow | mechanical | src/gate-runner.ts, src/land.ts |
| 04 land-path-verdict | narrow union over the ~6 land-path gates already returning `X \| undefined` | architectural | src/gate-verdict.ts (new), src/land-risk.ts, src/land-pr.ts, src/land.ts, src/proof.ts |
| 05 widen-or-stop | decide, on 01's evidence, whether the union earns its way past the land path | research | (scoping only) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 02 | live bug, independent, ships alone and immediately |
| 2 | 01 | must land BEFORE 04 so it regression-locks the land path first |
| 3 | 03 | prerequisite for 04; mechanical, isolated |
| 4 | 04 | the narrow union, guarded by 01's harness |
| — | 05 | deferred; decided on 01's evidence, not on appetite |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | — | `grep -n 'computeAheadOfBase' src/squad-manager.ts` shows bare `> 0` |
| 03 | — | `sed -n '355,370p' src/gate-runner.ts` shows three `return undefined` with different meanings |
| 04 | 01, 03 | harness exists and is green; `gateRunUnrunnable` returns a two-way result |
| 05 | 01 | harness has reported per-gate fault results |

## Notes
- Adversarially designed 2026-07-10: sonnet designer → 2 opus red teams → arbiter. **The panel
  rejected the original proposal** (a `GateVerdict` union across ~40 gates in 8 batches). See
  DESIGN.md — the constructor it centred on would have re-created the 1,381-death interlock, and its
  scope boundary excluded a live fail-open that a red team then found. What survives is one batch of
  type work behind one batch of tests.
- PR #160 (four defect ratchets) is the zero-token floor under all of this. Its
  `hand-written-retryable` ratchet shipped with **inverted guidance** and was corrected in `4dd0b32`
  after red team A caught it: the 14 literals are deliberate anti-park flags, a ceiling and not a debt.
- Three times this session the orchestrator's own framing was the defect source (the fix-list that
  caused the land-risk fail-open; the suppression list that hid a finding from review; that ratchet
  description). All three were caught only by reviewers who had not read the framing. `/blind-review`
  now exists for this and is wired into `/execute-plan`'s gauntlet.
- Explicitly NOT in scope, with reasons in DESIGN.md: `fromProbeFailure`, `acceptInconclusiveAsAllow`,
  `Allow{basis:"vacuous"}`, `landableDirty`, `alreadyDone`/`issueAlreadyDone`, `confidenceBelowFloor`,
  the `LandResult` refactor, the validator `abstain` verdict, the three wire enums, and
  convergence's throw-based discipline (a throw is *more* enforceable than a returned Inconclusive).
