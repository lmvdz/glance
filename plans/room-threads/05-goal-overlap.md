# Goal-level overlap detection
STATUS: done
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

## Built 2026-07-25 — with one correction to this concern's own approach

`goalConflicts` in `src/ownership.ts` ranks three signals: structural (shared declared paths, issue or
plan refs), semantic concept overlap, and BM25 as the lexical fallback. The result carries `{agent,
strength}` and nothing else — no goal, path, issue or plan reference can be added to it, and a test
asserts the shape rather than trusting the comment.

**Point 1 of the Approach above was wrong, and this is the correction.** It said to lift
`ownershipConflict`'s blocking behaviour to goals. Blocking is right for structural overlap — a shared
declared reference is exact, and paths already block. It is wrong for the fuzzy signals: the
dispatcher's own two fixture issues ("issue a / spec a" and "issue b / spec b") score 0.67 against each
other, and three dispatcher tests hung when the first implementation refused the second spawn. The
fleet's entire job is running many units in one repo, so a heuristic that can refuse a spawn is
unusable at any threshold.

So structural overlap blocks and the fuzzy signals **disclose** — a manager-authored card naming the
owner and stating plainly that nothing was blocked. That is what the law-firm conflict check actually
is: the firm tells you a conflict exists; it does not refuse to open your mail.

**The Verify list was also missing its other half.** It asked for a false-NEGATIVE corpus and said
nothing about false positives — for a mechanism that can refuse work, that is the expensive direction.
A false-positive corpus is now in place, and it immediately found a real defect: a one-word goal scored
a total match after concept folding ("rate" collapses to "rate-limit", 1/1), so a spawn could be
refused on no evidence at all. Fixed with a minimum-evidence floor counted on RAW terms before folding
— counting after folding is equally wrong in the other direction, since "rate limiting" is two real
words that fold to one concept and is a perfectly good goal.

## Cross-Repo Side Effects
None.

## Verify
- Two nodes with semantically similar goals and no shared paths are flagged at creation.
- A non-member gets existence + owner and no content; asserted, not assumed.
- Structural overlap outranks semantic overlap in the result order.
- A false-negative corpus test: known-duplicate goal pairs must all be caught.
