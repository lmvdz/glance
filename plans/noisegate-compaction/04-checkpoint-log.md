# Checkpoint persistence: tail-preserving fields + redaction
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/workflow/checkpoint-log.ts, tests/checkpoint-log.test.ts
BLOCKED_BY: 01, 02

## Goal
Checkpoint `lastOutput`/`lastText` keep failure signal and offload pointers under the 4096 cap, redacted at persistence.

## Approach
- `lastOutput`: `classifyAndReduce(redact(value), MAX_FIELD_BYTES, {command: undefined}).text` — sync core only (NO reduceOutput: the executor already offloaded; a second offload double-writes). Marker/pointer lines are CRITICAL-tier so a pointer never gets amputated on the rare re-reduction.
- `lastText`: `redact()` + plain `headTail(value, MAX_FIELD_BYTES)` — agent PROSE, never shape-classified (a quoted `error TS` line must not trigger diagnostics-class selection on prose).
- Redaction is new here (checkpoint JSONL persisted raw today) — scope claim: these two fields only; other vars stay as-is (documented).
- Rewrite tests/checkpoint-log.test.ts:134-143 (asserts old `…(truncated)` suffix/length — breaks by design). Add: oversized lastOutput containing a pointer line → pointer survives; boundary test at the REAL post-fix executor max (~4030), not the draft's false ~4050 premise; NO storage-backend writes from appendCheckpoint (sync-only proof).

## Cross-Repo Side Effects
None.

## Verify
`bun test tests/checkpoint-log.test.ts` green including the rewritten assertions.
