# Epic 4 — Replayable traceability · Overview

## Outcome
For any landed change, a reviewer walks the full causal spine
issue → dispatch/spawn → run → verify → (validate) → land → observe in the FleetPulse trace UI,
opens the actual reasoning/IO at a run/verify node, and sees NO alarming "partial" badge on a
finalized decision spine. The trail survives a daemon restart (it already does — receipts + audit on
disk) and, by default, also streams to a durable local `traces.jsonl` sink for external tools.

Read DESIGN.md first — D1–D4 are the decisions every leaf assumes.

## Work table

| # | Concern | Complexity | Touches | Depends |
|---|---------|-----------|---------|---------|
| 01 | Retain structural spans through sampling | mechanical | src/spans.ts, src/receipts.ts, src/types.ts, tests/spans.test.ts | — |
| 02 | Weave verify/spawn audit into the causal spine | architectural | src/spans.ts, src/omp-graph/provenance.ts, src/types.ts, tests/spans.test.ts | 01 |
| 03 | Durable-by-default local export + bounded retry | mechanical | src/trace-exporter.ts, src/squad-manager.ts, tests/trace-exporter.test.ts | — |
| 04 | Link the per-agent digest into the trace tree | mechanical | src/spans.ts, src/server.ts, tests/trace-api.test.ts | — |
| 05 | Surface the woven spine + reasoning link + honest sampling label | architectural | webapp/src/components/WorkflowGraphOverlay.tsx, webapp/src/lib/dto.ts, webapp/src/omp-graph/Inspector.tsx, webapp/src/omp-graph/types.ts | 02, 04 |

## Batch order

- **Batch A (parallel):** 01, 03, 04 — independent backend changes, no shared files beyond spans.ts
  (01 edits `snapshot`/`shouldKeepSpans`; 04 edits `ATTR_KEYS`/`start`; disjoint regions — land 01 first
  if the same agent takes both, else rebase).
- **Batch B:** 02 — needs 01's structural-span guarantee so the woven spine renders without `partial`.
- **Batch C:** 05 — needs 02's woven backend spine + `sampled` flag and 04's `/api/digest` endpoint.

## Dependency graph (30s check per edge)

```
01 ──▶ 02 ──▶ 05
04 ─────────▶ 05
03 (independent)
```

- **01 → 02:** run `bun test tests/spans.test.ts` — 02's "run→verify→land tree, partial=false" assertion
  only holds once 01 makes finalized receipts always carry structural spans. Without 01, `partial` stays
  true and the spine node is the fallback run span only.
- **02 → 05:** `curl /api/trace/<id> | jq '.root'` shows `verify`/`spawn` child spans and a `sampled`
  field before 05's UI can render them; if the JSON lacks those keys, 05 has nothing to draw.
- **04 → 05:** `curl /api/digest/<agentId>` returns markdown (not 404) before 05 can wire the
  "open reasoning/IO" link; a node's `attrs.digest` must resolve to a real endpoint.
- **03 independent:** no other leaf reads `traces.jsonl`; it only adds an export sink.

## Definition of done (epic Verify)
`bun test` green. Then live: start the daemon with no OTLP env, drive one fixture run to land, open the
FleetPulse Inspector → "Trace on canvas" / TraceDrilldown, confirm the waterfall shows
run→verify→land with a reasoning link, no "partial" badge on the finalized spine, and that
`<stateDir>/traces.jsonl` grew. Restart the daemon; re-open the same trace — it is still fully there.
