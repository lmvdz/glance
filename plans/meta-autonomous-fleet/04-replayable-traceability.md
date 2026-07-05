# Epic 4 — Replayable traceability
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/trace-exporter.ts, src/spans.ts, src/receipts.ts, src/audit.ts, src/automation-log.ts, src/squad-manager.ts, src/omp-graph/provenance.ts, webapp/src/omp-graph/Inspector.tsx
SUBPLAN: plans/meta-autonomous-fleet/epic-4-replayable-traceability/

## Goal

A fully replayable end-to-end decision trail: for any landed change, reconstruct the causal chain issue → dispatch → spawn → run → verify → validate → land → observe, with the reasoning and IO that produced each step, surfaced in the already-built FleetPulse/provenance UI.

## Approach

The trace subsystem is **not broken** — it's off-by-default and coarse by design. `SpanCollector` (`src/spans.ts:126`) → `finalizeRun` enqueues to the exporter → `buildTrace` (`src/spans.ts:333`) → `/api/trace/:id` → `WorkflowGraphOverlay`/`TraceDrilldown`. Four things make it read as stubbed: (1) `traceExporterFromEnv` returns undefined unless an OTLP/Langfuse/Datadog URL is set, so nothing leaves the daemon by default; (2) `TraceExportQueue` drops on overflow with no durable retry; (3) `traceSampleRatio` defaults to **0.1** so 90% of successful runs keep only a rollup and `buildTrace` returns `partial: true`; (4) span `attrs` are redacted + truncated to 240 chars, so prompts/outputs live only in the per-agent transcript/digest, which is **not linked into the trace tree**.

Three disconnected append-only streams exist — `audit.ts` (actor/action), `automation-log.ts` (orchestrator/observer ticks), `receipts.ts` (per-run spans) — that `buildTrace` only partially stitches. Weave them plus transcripts and orchestration decisions into one causal chain. FleetPulse's provenance/attribution backend (`src/omp-graph/*`) and `Inspector.tsx` (already fetches `/api/graph/provenance` and has an `onTrace` hook) are the render surface — no new UI framework needed.

## Decomposition seed (candidate leaves for the sub-plan)

- Keep decision spans unconditionally: raise/override `traceSampleRatio` for `goalGate`/verify/validate/land nodes so decision steps are never sampled away.
- Turn on durable local export by default (append to a durable store, not just fire-and-forget OTLP); bound + retry instead of drop-on-overflow.
- Link the per-agent transcript/digest into the trace tree (a span attr referencing the digest id) so reasoning/IO is reachable from a node.
- Weave orchestration decisions (`automation-log`/`dispatch-ledger`/`audit`) into `buildTrace` as causal edges (why spawned/dispatched/reaped).
- Surface the woven chain in `Inspector.tsx` provenance pane; drop `partial: true` when the decision spine is complete.

## Verify

For a landed change, open the FleetPulse Inspector and walk the full chain issue→dispatch→spawn→run→verify→validate→land→observe, opening the actual prompt/output at a verify node — with no `partial: true` on the decision spine. Restart the daemon and confirm the trail survives (durable, not memory-only).
