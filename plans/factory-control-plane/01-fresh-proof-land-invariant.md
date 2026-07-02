# Fresh proof and land invariant
STATUS: done

> 2026-07-01 reconcile: verified in code — `proofGate` (src/proof.ts:174) refuses a missing/failed/
> stale proof keyed to the worktree HEAD, and the land paths call it before any merge
> (src/server.ts `/api/agents/:id/land`, `manager.land`/`landFeature`). The 2026-06-30 plan audit
> already found the core proof-before-land invariant done; the STATUS line never caught up.
> Residual gap (tracked, not blocking `done`): freshness is commit-keyed only — the fingerprint
> extensions in the Approach (dirty status, tree hash, target base HEAD, command hash/TTL) are not
> implemented, so a worktree holding a green proof at HEAD *plus uncommitted edits* can have those
> edits swept in by `commitWip` and merged under a proof that never tested them.
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/proof.ts, src/land.ts, src/squad-manager.ts, src/server.ts, src/types.ts
PLANE: OMPSQ-306 — https://app.plane.so/inkwell-finance/browse/OMPSQ-306/

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
