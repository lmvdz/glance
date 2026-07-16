# Append-only event store writer
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/land-assessment/store.ts, src/land-assessment/store.test.ts

## Goal
The durable append-only store: per-repo month-sharded JSONL that can never tear its own replay consumer and never stalls a land.

## Approach
- Layout: `<stateDir>/land-assessment/<repoHash16>/events-<YYYY-MM>.jsonl` (repoHash per proof.ts's sha1-of-resolved-path convention). Files are append-only, never rotated-with-clobber, never rewritten. No retention policy in v0 (documented as a later-phase decision).
- **Single-writer discipline**: one in-process async mutex per file path serializes ALL appends (hook writes, background completions, invalidations) — independent of `withRepoLandLock`, because background analyses complete outside it. Multi-KB events under concurrent O_APPEND tear (Node splits large buffers across write() syscalls); the mutex is the fix, and a doc comment records why.
- **Per-line integrity**: each line is `<crc32>:<json>` (or an equivalent length-prefix scheme) so the reader can distinguish a torn line from valid data; the store stamps the per-file monotonic `seq` field at append time.
- **Off-hot-path durability**: appends are queued and flushed asynchronously; fsync happens on the writer queue, NEVER on the land thread (WSL2 fsync-spike memory: a synchronous fsync on the land path would stall every land when the host degrades). A write failure emits high-severity telemetry (automation log) and the land proceeds — best-effort per BRIEF §10.7, but never silent.
- Dedup rule from concern 01: an append whose `(assessmentId, resultHash)` already exists in the current shard is dropped (exact re-run no-op).
- Write path uses `getStorageBackend().appendDurable` under the mutex for the actual I/O; corrupt-on-read semantics live in `store-reader.ts` (concern 06), keeping writer and reader disciplines separate and testable.

## Cross-Repo Side Effects
None — new module; consumers wire in later concerns.

## Verify
`bun test .../store.test.ts`: concurrent-append stress (N parallel writers, multi-KB events) yields zero torn lines and correct seq ordering; CRC detects an artificially truncated line; dedup drops an identical re-append; a failing underlying write surfaces telemetry without throwing to the caller.
