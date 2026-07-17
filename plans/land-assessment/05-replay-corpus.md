# Replay corpus reconstruction and synthetic pair generator
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 02
TOUCHES: src/land-assessment/replay/corpus.ts, src/land-assessment/replay/synthesize.ts, src/land-assessment/replay/corpus.test.ts

## Goal
Reconstruct (B, M, C) triples + outcome labels for glance's historical lands from three sources, and generate class-tagged synthetic concurrent-change pairs — the four evaluation sources of BRIEF §10.4 made concrete.

## Approach
`corpus.ts`, three reconstruction sources, each triple tagged with its source for confidence slicing:
1. **Merge commits**: `git log --merges --first-parent <main>` — P1 = M, P2 = C, `merge-base P1 P2` = B.
2. **Squash/rebase/ff PR merges**: `gh pr list --state merged --json number,headRefOid,baseRefOid,mergeCommit,mergedAt` (field availability verified). Requires the SHAs fetched locally (`git fetch origin <sha>` / PR refs); network dependency documented — replay degrades per-PR to a coverage gap offline, never fabricates.
3. **FF local-mode lands** (invisible to 1 and 2): the main-proof/done-proof ledgers (`recordMainProof` writes at land.ts:625/652/724-era sites; `done-proofs.json` byBranch records) give branch + commit + baseRef to recover triples.
Outcome labels joined from `done-proofs.json` (verified green/red-baseline), `land-failures.json`, `land-forced.json`, `land-validator-override.json` — joined by branch/commit equality, never substring. Rejected-history thinness reported, not hidden: the corpus output includes a `coverage` block stating how many attempts each source recovered and what is known-unrecoverable.
`synthesize.ts`: controlled AST mutations on real dogfood-repo files per claimed structural class (signature change, export removal, inheritance change, adjacent-dependency edit), producing two divergent in-memory branches from a common base; each pair tagged with its target class. Deterministic (seeded selection), no LLM. **Circularity caveat carried in the output**: pairs are generated with the same TS API the analyzer uses; the report (concern 06) must label synthetic-only recall as such.
Temporal holdout: a pure `--split-at <date>` filter over the reconstructed corpus.

## Cross-Repo Side Effects
None.

## Verify
`bun test`: on a fixture repo with a scripted history (one true merge, one squash-simulated, one ff land recorded in a fixture ledger), all three sources recover correct triples; label joins hit; synthetic pairs regenerate byte-identically from the same seed. Manual: run against the real repo, spot-check 3 known PRs' triples against GitHub.
