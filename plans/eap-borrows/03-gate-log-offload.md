# Lossless gate-log offload + diff-aware budgeted excerpts (validator half)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/gate-logs.ts (new), src/validator.ts, src/types.ts, tests/

## Goal
Oversized artifacts on the validator path stop being silently truncated: the full text persists
as a durable per-agent log file (path = pointer, stamped on the record and readable by humans),
and the one-shot judge gets a deterministic, diff-aware excerpt instead of head-truncation.

## Approach
- New `src/gate-logs.ts` on the StorageBackend seam (src/dal/storage.ts — verified live on main):
  `writeGateLog(agentId, kind, content) -> { path, bytes }` writing
  `<stateDir>/gate-logs/<agentId>/<ts>-<kind>.log` via writeDurable. Unique path per write —
  no same-path concurrency, no tmp collision (the CAS design was cut; see DESIGN.md).
  `sweepGateLogs()` by mtime, default 14d, mirroring the proof-sweep cadence style.
- `budgetedExcerpt(s, budget, meta)`:
  - `s.length <= budget` → return as-is, write nothing.
  - Diffs (meta.kind === "diff"): diffstat header + whole hunks greedily to budget (never bisect
    a hunk — a split hunk shows phantom deletions to a regression-hunting lens).
  - Logs/proof tails: head 0.5 + tail 0.5 (conclusions live in tails).
  - Oversized → writeGateLog and append `[N bytes omitted — full: <path>]` to the excerpt.
  - NEVER throws: any write failure logs and falls back to plain truncate — a throw here would
    fail-close a land (validator.ts:236-238 contract).
- Wire into `judgeUserPrompt` (validator.ts ~150-154) and `lensUserPrompt` (~220-223) replacing
  `truncate(diff, 12000)` / `truncate(proof.detail, 2000)`. Both Judge closures are already
  async-compatible (decideTyped returns a Promise) — verify at implementation.
- Stamp the log path onto ValidationRecord (types.ts) so post-hoc forensics need no search.
- land.ts / land-pr.ts call sites are concern 07 (same helper, G3-gated files).

## Cross-Repo Side Effects
None.

## Verify
Tests: small input passes through untouched with no file; oversized diff excerpt contains only
whole hunks + diffstat + pointer line; write-failure path returns plain truncation and never
throws; sweep removes only stale files. Live check: run a validator judge against a >12k-char
diff in a scratch daemon and confirm the full log file exists and the verdict prompt carries the
pointer.
