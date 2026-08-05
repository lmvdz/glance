# Survival engine (blame --reverse, churn-adjusted, modifier-classified)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/impact/survival.ts (new), src/impact/churn.ts (new), tests/impact-survival.test.ts (new)

## Goal
For a ledger entry at a given offset: % of added lines unmodified (raw n/d), per file-churn bucket, with every modifying commit classified by who made it.

## Approach
- Primitive: `git blame --reverse <mergeSha>..HEAD -L<start>,<end> -- <path-at-mergeSha>` per recorded range (red-team-verified: resolves ranges at mergeSha coordinates, survives file deletion at HEAD, follows renames, ~0.2s/query; `git log -L` is WRONG — it resolves at the newest revision). `--no-ext-diff --no-textconv` on everything diff-shaped.
- Wrap all reads for a repo in `withRepoLandLock` (src/land.ts:475-480) — local-mode lands merge into the shared checkout and `reset --hard` on gate failure; unlocked reads count about-to-be-rolled-back commits.
- Modifier classification for each commit that touched a range, via ledger joins only (no trailers): **sameUnit** (SHA ∈ this entry's branchCommits, or ledger entry with same agentId), **sameFeature** (modifying commit's ledger entry shares featureId — kills fork-id misclassification), **otherAgent** (in some other ledger entry), **human** (in no ledger entry), **deletedWithinWindow** (all of a range's lines removed, not edited — the real rejection signal in a fix-forward fleet; there is NO `^Revert` category, it's a dead sensor here).
- Churn buckets: modifications to the unit's files overall in the window (`git log --since` counts) → tertiles; survival is reported per bucket and never compared across buckets. No medians (majority-censored at +28d; median-of-modified conditions on churn). Output shape: `{bucket, linesTotal, linesModified, byModifier: {...}, filesDeleted, gap?}`.
- Concurrency cap 2 on subprocess spawns (measured volume ≈ 1,100 blame calls/day ≈ 4 CPU-min — correctness, not scale, is the risk).

## Cross-Repo Side Effects
None.

## Verify
Fixture-repo tests: lines shifted by an insertion above the range (asserts NO false modification — the exact log -L failure); file renamed post-land; file deleted post-land; sameFeature fork commit classified correctly. Live: run against 5 real ledger entries and hand-check one hot-file unit and one leaf-module unit.
