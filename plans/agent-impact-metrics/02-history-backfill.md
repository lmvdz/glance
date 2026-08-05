# History backfill via first-parent merge walk
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 01
TOUCHES: src/impact/backfill.ts (new), scripts/impact-backfill.ts (new), tests/impact-backfill.test.ts (new)

## Goal
Reconstruct ledger lines for pre-ledger lands so the first cohorts aren't empty — marked lossy, never presented as equal-confidence data.

## Approach
- Walk `git rev-list --first-parent --merges <default>` (bounded window, e.g. 90 days); for each merge commit, match its second parent against `done-proofs.json` `.commit` values and `pending-prs.json` branches to recover `{agentId, featureId, prNumber}`. This sidesteps the branchTip-recorded-as-mergeCommit bug (src/land-pr.ts:443) that makes naive done-proof backfill systematically wrong.
- addedRanges from the same first-parent diff as concern 01. Non-merge (squash/rebase/local-ff) history that can't be matched: emit a range-less line with `backfill: "unmatched"` — never guess.
- Every backfilled line carries `backfill: "reconstructed"|"unmatched"`; cohort reports must show "N of M units reconstructed from lossy snapshots".
- One-shot CLI (`bun scripts/impact-backfill.ts`), idempotent via mergeSha dedupe.

## Cross-Repo Side Effects
None.

## Verify
Run against this repo's real last-90-days history; spot-check 5 reconstructed lines against `gh pr view` ground truth; assert zero lines whose mergeSha is not reachable from main.
