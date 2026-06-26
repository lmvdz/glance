# Fresh proof and land invariant
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/proof.ts, src/land.ts, src/squad-manager.ts, src/server.ts, src/types.ts

## Goal

Prevent unverified content from landing. A passing proof must describe the exact tree that will be merged.

## Approach

- Replace commit-only proof freshness with a fingerprint: repo/worktree identity, branch, commit, tree hash, dirty status, target base HEAD, command hash/source, runner policy, timestamp/TTL, artifacts.
- Refuse autonomous proof recording for dirty worktrees, or create the final commit first and verify that commit/tree.
- Make `land()` enforce fresh proof for every non-forced path, including orchestrator and workflow auto-land.
- Keep explicit manual force possible only with actor, reason, and audit entry.
- Move proof records under manager/org stateDir rather than global path-hash storage.

## Cross-Repo Side Effects

None.

## Verify

- Add a focused test where a worktree is verified, then changed before land; land must fail with stale proof.
- Add a focused test where auto-land uses `land()` and refuses missing/stale proof.
- Run the affected Bun tests for proof/land paths.
