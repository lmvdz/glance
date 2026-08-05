# Landed-units ledger + land-site instrumentation
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/impact/ledger.ts (new), src/impact/added-ranges.ts (new), src/land.ts, src/land-pr.ts, src/squad-manager.ts, tests/impact-ledger.test.ts (new)

## Goal
A durable, append-only per-land record joining unit → true merge commit → exact contributed line ranges, written at every path where a land actually completes. This is the spine every other concern reads.

## Approach
- New `src/impact/ledger.ts`: `appendLandedUnit(stateDir, entry)` / `readLandedUnits(stateDir, repoKey)` over `<stateDir>/impact/<repoHash16>/landed-units.jsonl` using `getStorageBackend().appendDurable` (O_APPEND+fsync — never `writeDurableSync`, which whole-file-replaces and clobbers concurrent appenders). Entry: `{schemaVersion, agentId, featureId?, repoIdentity, repo, branch, mode, mergeMethod, baseSha, mergeSha, branchCommits: string[], addedRanges: [{path,start,end}], excludedPaths: string[], prNumber?, landedAt}`. Read-time dedupe on `mergeSha`. Store `repoIdentity()` in the line (repoHash16 is a local-path hash; a moved checkout must not orphan history).
- **True merge SHA**: under `mergeMethod() === "merge"` (the default, src/land-pr.ts:147), `assertMerged` returns branch tip as `mergeCommit` (src/land-pr.ts:440-443). Resolve the real merge commit post-merge (`gh pr view --json mergeCommit`, or `git rev-list --first-parent --merges` scanning for second parent == branch tip). Local mode: capture `rev-parse HEAD` only at the ok:true return points — the red-baseline path re-merges with a new SHA (src/land.ts:653, :715); ff-only merges create no merge commit (mergeSha = tip is correct there).
- **addedRanges**: `git diff -U0 --no-ext-diff --no-textconv mergeSha^1 mergeSha` (first-parent diff = exactly what the land contributed; immune to base drift). Never diff stored baseSha vs recorded mergeCommit. Path-exclude lockfiles/generated (bun.lock, pnpm-lock.yaml, *.snap, dist/) and record `excludedPaths`. Pure deletions ⇒ zero ranges; record the entry anyway (deletion credit reads it, concern 06).
- **branchCommits**: `git rev-list baseSha..mergeSha` at land time — modifier classification (concern 03) becomes a set lookup; no trailers anywhere (red team proved land-site commits are WIP-sweeps only; agent work commits never pass through the land paths).
- **Three write sites**: (1) src/land.ts local-mode ok-return; (2) src/land-pr.ts after `recordDoneProof` (~:849), mirroring its crash-window pattern; (3) the pr-reconcile out-of-band merge detector (src/squad-manager.ts ~:9911-9970) — it already resolves agentId and, for squash/view, the *real* merge commit; without it human-GitHub-UI merges and gh-timeout merges vanish from accounting.
- All git calls through `hardenedGit` (thin wrapper shape of src/land-assessment/analyzers/plugin.ts:69); every diff-shaped command carries `--no-ext-diff` (empty `diff.external` hardening kills output otherwise — src/validator.ts:580).
- Also populate `LandAttemptEvent.refs.agentRunRef/featureRef` in src/land-assessment/hook.ts:178 (two live readers exist; disagreement with the ledger logs an anomaly — cross-check, non-blocking).
- Everything behind `OMP_SQUAD_IMPACT_METRICS=1`; ledger writes are fire-and-forget (never fail a land).

## Cross-Repo Side Effects
None.

## Verify
Unit tests: dedupe-on-mergeSha; first-parent range extraction against a fixture repo with a concurrent-main-commit scenario (asserts main's work is NOT attributed); local re-merge captures the final SHA. Live: flip the flag in a scratch daemon (scratch-daemon skill), land one unit each via local + PR path, confirm three-field-correct ledger lines; merge a PR by hand in the UI and confirm pr-reconcile appends.
