# Impact snapshot loop + cost rollup
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 03, 04
TOUCHES: src/impact/snapshot.ts (new), src/impact/cost.ts (new), src/squad-manager.ts, src/types.ts, tests/impact-snapshot.test.ts (new)

## Goal
A daemon loop that measures each ledger entry at +7/+14/+28 days and persists one snapshot file per (land, offset); cost joined at feature level.

## Approach
- `ImpactSnapshotLoop` cloned from `EpisodeLoop` (src/weekly-episode.ts:411-529): hourly tick, durable idempotency via `snapshotExists(stateDir, repoKey, mergeSha12, offsetDays)` — keyed by **land identity, not agentId** (one agent lands many times; agent-keying silently drops every land after the first). Repos re-derived every tick. Wire in `SquadManager.start()` after the episode block, gated `OMP_SQUAD_IMPACT_METRICS=1`.
- Snapshot file `<stateDir>/impact/<repoHash16>/snapshots/<mergeSha12>-<offsetDays>.json` via `getStorageBackend().writeDurable`, Effect Schema-decoded on read, SCHEMA_VERSION const. Record `scheduledOffsetDays`, `actualAt`, and the HEAD SHA measured against (daemon downtime ⇒ a +7 measured at day 9 must say so); record origin-fetch staleness.
- Pure `buildImpactSnapshot(input)` (no I/O, no Date.now in render path); gather() deps injected — survival (concern 03), reference index (concern 04) — each block carries its own `gap?` field straight through.
- Cost block: denominator = **featureId rollup** — union of receipts across all member agentIds (`src/features.ts:897` members) and parentId chains (receipts carry featureId/parentId at src/receipts.ts:33-34) — never a bare per-agentId sum (forks mint new ids; per-id sums report ~25% of true cost for flaky work). No featureId ⇒ cost gap "unattributable predecessors possible". Cost-coverage line: "cost present on N of M receipts (K estimated)" — ingested harness costs are rate-table estimates (src/ingest/claude-code.ts:8), and missing costUsd must never silently read as zero; below full coverage, impact-per-dollar is a gap. Note reads "validator cost unmeasured" (validators don't write receipts).
- Add `"impact"` to the `AutomationLoop` closed union (src/types.ts:1572); report via `automation.for("impact", repo)` — `{found:0, filed:0}` no-level on no-op ticks, `level:"warn"` on gather/save failure.

## Cross-Repo Side Effects
None.

## Verify
Tests: idempotency (double tick ⇒ one file); late-catch-up records actualAt; fork-chain cost rollup fixture sums all predecessor receipts; missing-cost receipts flip impact-per-dollar to gap. Live in scratch daemon: seed a ledger entry backdated 8 days, tick, confirm a +7 snapshot with correct gap declarations.
