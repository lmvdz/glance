# Serialized verify and land orchestration
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/orchestrator.ts, src/orchestrator-state.ts, src/scheduler.ts, src/types.ts

## Goal

Make verify/land a serialized state machine so autodrive cannot double-verify, double-land, or race itself.

## Approach

- Add a single-flight guard around `Orchestrator.tick()`.
- Add per-agent/run verify-land locks so one slow proof blocks duplicate work for the same agent only.
- Persist `verifying` before awaiting proof and persist terminal states with a run/branch/head identity, not branch name alone.
- Stop treating branch-only terminal decisions as permanent; include repo + branch + head commit or runId and prune stale entries.
- Fail closed if critical state persistence fails for `verifying`, `verified`, `blocked`, `landed`, `halted`.

## Cross-Repo Side Effects

None.

## Verify

- Add a test that forces overlapping ticks and proves only one proof/land path runs.
- Add a test that reuses a branch name at a new head and is not skipped by stale orchestrator state.
