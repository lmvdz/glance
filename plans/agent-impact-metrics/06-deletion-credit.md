# Deletion credit
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 01
TOUCHES: src/impact/deletion-credit.ts (new), tests/impact-deletion-credit.test.ts (new)

## Goal
A vector where cleanup can win: dead-export reduction and net line deletion attributed to the unit — the counterweight to every other metric's accretion gradient.

## Approach
- At snapshot time, for a ledger entry: (a) net lines deleted from the first-parent diff stats (already derivable from the entry); (b) dead-export delta — run `scan()` from scripts/dead-exports.ts at mergeSha^1 and mergeSha (or reuse its recorded ratchet baseline movement where the timestamps line up) and attribute the reduction.
- Under-counting direction is safe here (name-existence over-marks "referenced", so credited reductions are conservative) — the opposite polarity of concern 04's problem; state this in the module doc.
- Rendered as its own vector row with the same coverage sentence discipline.

## Cross-Repo Side Effects
None.

## Verify
Fixture: a unit that deletes a baseline dead export gets positive credit; a unit that adds one gets zero (not negative — DOA already covers that direction).
