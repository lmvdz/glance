# Observe-only land hook
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03, 04, 07
TOUCHES: src/land-assessment/hook.ts, src/squad-manager.ts, src/land.ts, src/land-pr.ts, src/land-assessment/hook.test.ts

## Goal
Phase 2: wire the envelope into the live land path — every attempt, every rejection, every invalidation recorded — while remaining observe-only by construction (the hook has no read side in land control flow) and adding no blocking I/O to the hot path.

## Approach
`hook.ts` exposes `startAssessment, completeOrInvalidate, recordRejection, recordResolution, recordPostMerge, recordTerminal` — every function try/caught internally; a hook failure is telemetry, never a throw into the land path (BRIEF §10.7).
Integration points (arbitrated corrections applied):
- `SquadManager.land()`: mint `attemptId` (durable counter, concern 01) immediately after the rec/dto resolve and BEFORE all early returns, so observer-refusal, force-without-reason, fail-cap parking, and forced-PR-mode refusal each emit `rejected` with distinct reason codes. `autoLandWorkflow` threads the same attemptId — it never mints (it calls land(); dual minting double-emits).
- Fingerprint capture: SHAs read synchronously with a sub-second timeout (degrading to an `unavailable` coverage event); `candidateCommit/candidateTree` captured AFTER `commitWip`, and `mainCommit` read under `withRepoLandLock`, so the fingerprint describes the state that actually merges. The hook's assessment key uses `path.resolve(repo)` identity.
- Analyzer execution: hybrid — raced against a 10s budget; on timeout the analysis continues in the background and appends whenever done. Before any backgrounding, pin the subject with `refs/land-assessment/<attemptId>/<sha>` (rebase/branch-delete/gc would otherwise prune it mid-analysis); drop the ref on completion/invalidation; an unreachable subject is an extractionCoverage gap.
- Invalidation: re-fingerprint at write time; mismatch (rebase via `attemptAutoResolve`, main advanced, PR-retry) ⇒ append `assessment-invalidated {supersedes}` + fresh assessment at the new fingerprint. `post-resolution-assessed` fires after attemptAutoResolve's rebase succeeds; `post-merge-verified` wraps the already-computed regression/acceptance outcome (no analyzer re-run); `landed`/`rejected` are mutually exclusive terminals.
- Rejection wiring covers every blocking return: the four early returns above plus proofGate, confidence-floor hold, validator veto, staleBranchReason, land-risk, regression-gate failure — each with reason code + a ref to the pre-merge assessmentId when one completed.
- Phase-2 additions of `proofFreshness` and `regression` record-time wrappers: at land time the live `Proof` and gate outcome ARE in hand — wrap them into the analyses envelope here (they were cut from Phase 1 because history can't replay them).

## Cross-Repo Side Effects
None outside omp-squad. The hook must not change any land decision, return value, or latency-visible behavior beyond the sub-second SHA capture.

## Verify
`bun test .../hook.test.ts` with a fixture land flow: every stage/rejection path emits exactly one event with correct attemptId threading (auto-land emits ONE attempt-started, not two); timeout path backgrounds and completes; invalidation fires on a simulated rebase. Live: scratch-daemon land of a trivial branch → inspect the store via `glance land-assessment inspect`; confirm a forced rejection also lands an event; confirm land latency unchanged (compare a before/after timed land).
