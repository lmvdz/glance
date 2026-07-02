# Fresh proof and land invariant
STATUS: done

> 2026-07-01 reconcile: verified in code — the full fingerprint from the Approach is implemented
> in src/proof.ts (`Proof`/`ProofFingerprint`: commit, tree, branch, dirty, baseCommit, repo/
> worktree identity, commandHash, TTL), `proofGate` names the exact staleness reason, and every
> land path gates (manager pre-gate + `landAgent`'s internal `requireProof` gate that re-checks
> AFTER the WIP sweep). The STATUS line never caught up with the code.
> Same day, one residual was found and closed: `dirty` ignored untracked files while the land's
> WIP sweep (`git add -A`) committed them — a file created after the proof landed untested. The
> fingerprint's dirty is now untracked-aware and the sweep excludes `.omp/` (evidence dir) so the
> gate and the sweep see the same tree.
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
