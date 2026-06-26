# Durable event journal for replay
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/dal/store.ts, src/sessions.ts, src/squad-manager.ts, src/server.ts

## Goal

Make sessions inspectable and replayable from structured durable events, not capped in-memory transcripts.

## Approach

- Add append-only event records with `{seq, schemaVersion, runId, agentId, actor, causationId, at, type, payload}`.
- Persist-before-emit for lifecycle, mode transitions, proof attempts, land attempts, tool blocks, approval answers, workflow state changes, and final outcomes.
- Keep snapshots as cache/compaction, not authoritative replay.
- Reuse existing redaction paths before writing journal payloads; cap raw excerpts and store artifact refs for bulky output.
- Add server endpoints/WS payloads that can serve journal slices by cursor.

## Cross-Repo Side Effects

None.

## Verify

- Add a store test that journal sequence is monotonic and survives restart.
- Add a redaction test proving prompt/proof/audit payloads do not bypass existing secret redaction.
- Add a replay test that reconstructs a small session timeline from journal + snapshot.
