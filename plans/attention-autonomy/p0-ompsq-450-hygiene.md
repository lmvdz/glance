# P0 — OMPSQ-450: attention-store lifecycle hygiene

STATUS: open
PRIORITY: p0
COMPLEXITY: simple
BLOCKED_BY: (none)
TOUCHES: src/attention.ts, src/manager-registry.ts, tests/attention.test.ts

## Goal
Fix the substrate before building on it: (a) the manager-registry get()/evictIdle() race that
AttentionStore.scheduleWrite's `closed` flag makes inert but not refused (attention.ts:390-407 —
an interim write is silently discarded, last-flush-wins); (b) unit-visited.json /
unit-completed.json grow one entry per agent id forever — add prune-on-load against the live
roster + cap/TTL (the charter's own locked constraint); (c) same-ms visitedAt===completedAt tie
residual stays deferred (documented as deliberate).

## Verify
Unit tests: prune-on-load against a roster set; the eviction race under a fake registry.
`bun test` + tsc clean.
