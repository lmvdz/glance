# Goal-level overlap detection
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/ownership.ts, src/nodes.ts, src/squad-manager.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
Two teams chasing the same goal find out at creation time, when duplication is cheapest to prevent —
without either being able to read the other's private work.

## Approach
1. `ownershipConflict` already blocks a spawn on overlapping PATHS and names the holder. Lift the same
   primitive to GOALS: two teams building "rate limiting" and "request throttling" share no files until
   the PR, which is far too late.
2. Structural signals DOMINATE and are precise: shared repo, shared `owns`/`produces` paths, shared
   plan/issue refs. Semantic similarity over node goals is the fuzzy fallback that catches the naming
   case. Fold in the existing BM25 fabric search as a third signal.
3. **Not GraphRAG.** We declare the graph (`refs`, ownership, `BLOCKED_BY`); GraphRAG's value is
   inferring one from unstructured text, its indexing is LLM-calls-per-chunk against static corpora,
   and a probabilistic summariser is the wrong risk profile when a false negative costs a duplicated
   week. This is an embedding index over a few thousand short strings.
4. Cross-boundary disclosure: to a requester without membership, reveal EXISTENCE, OWNER and a
   request-access path — never content. The law-firm conflict check.

## Cross-Repo Side Effects
None.

## Verify
- Two nodes with semantically similar goals and no shared paths are flagged at creation.
- A non-member gets existence + owner and no content; asserted, not assumed.
- Structural overlap outranks semantic overlap in the result order.
- A false-negative corpus test: known-duplicate goal pairs must all be caught.
