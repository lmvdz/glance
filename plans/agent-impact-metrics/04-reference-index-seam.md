# Statically-referenced index (codegraph seam with usability gates)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/impact/reference-index.ts (new), src/impact/added-exports.ts (new), tests/impact-reference-index.test.ts (new)

## Goal
Per ledger entry: which added exported symbols have inbound edges from post-land, cross-feature code — with a per-file usability gate so an incomplete index yields a declared gap, never a confident zero.

## Approach
- Added-export extraction: reuse `extractStateFacts` (src/land-assessment/analyzers/typescript-structural-delta.ts) over the entry's addedRanges files at mergeSha — EXPORTS_ADDED keyed by symbol. Instrumentability is the FIRST output: `{candidates, totalAddedSymbols}`; zero candidates ⇒ the whole unit renders "not instrumentable by this lane" (measured: 44% of recent merges add zero exports — this must lead, or the lane lies by omission).
- `referenceIndex(symbols, entry): {perSymbol} | {gap: reason}` reading `.codegraph/codegraph.db` read-only via `bun:sqlite`. **Usability gates, per unit per file** (the DB is live-verified 70% incomplete and answers confidently for unindexed files): (a) every file holding the unit's added symbols present in `files`; (b) indexed content hash matches the blob at current HEAD; (c) indexed_at postdates mergeSha commit time; (d) the files' unresolved-ref density below threshold; (e) `schema_versions` matches a pinned value. Any failure ⇒ gap with reason. Discover exact schema at build time (`SELECT sql FROM sqlite_master`); it is external and unversioned — treat drift as gap, never throw.
- Edge semantics: `calls` counted separately from `imports`; edges from files whose ledger entry shares featureId ⇒ **sameFeature** (reported separately — split-farming defense); only crossFeature calls back the "statically referenced" claim. `unresolved` share is its own rendered category (live DB: unresolved refs outnumber resolved calls ~4:1). Carry dead-exports.ts's entrypoint/string-dispatch exemptions (src/index.ts, *-main.ts, @substrate) into the classifier — string-dispatched work goes to gap, not "unreferenced".
- Name-existence matching (dead-exports.ts style) is permitted ONLY as a fleet-wide ceiling figure, never per-agent, never agent-readable (gameable by identifier reuse; concern 09 enforces).
- Seam interface designed so a structural-delta CallExpression resolver can become a second implementation later without touching consumers.

## Cross-Repo Side Effects
None.

## Verify
Tests: unindexed-file unit ⇒ gap not zero; stale-hash file ⇒ gap; sameFeature edge classified; schema-drift fixture ⇒ gap. Live: run against a known-referenced symbol (e.g. something in src/receipts.ts) and a known-dead export from the dead-exports baseline; verify direction of both.
