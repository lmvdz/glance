# Epic 4 — Replayable traceability · DESIGN

The trace subsystem is real and wired, not broken. It reads as stubbed only because of three
config/behaviour choices this epic reverses. These are the decisions every leaf depends on —
they are made here so the leaves carry zero unresolved judgment.

## Ground truth (verified against the current tree)

- `SpanCollector` (src/spans.ts:126) emits `run` / `node` / `tool` / `subagent` spans during a run.
- `RunAccumulator.snapshot` (src/receipts.ts:122) attaches those spans to the `RunReceipt` **only when
  `shouldKeepSpans` votes yes** — default sample ratio `0.1` (src/spans.ts:75), so ~90% of successful
  runs persist *no* fine spans, only the lossless rollup.
- `finalizeRun` (src/squad-manager.ts:4363) writes the receipt to disk via `appendReceipt`
  (durable, both modes) and *also* fires `this.traceExporter?.enqueue(...)` (line 4370) — but
  `traceExporterFromEnv` (src/trace-exporter.ts:193) returns `undefined` unless an OTLP/Langfuse/Datadog
  URL is set, so by default nothing is exported and `TraceExportQueue` drops on overflow (line 163).
- `manager.trace(id)` (src/squad-manager.ts:4487) rebuilds the tree at read time via `buildTrace`
  (src/spans.ts:333), stitching receipts + **audit-derived** `land`/`resolve` spans (`auditSpans`,
  src/spans.ts:310). `partial: true` is set when any receipt lacked fine spans (line 356).
- `auditSpans` today filters audit to **only** `land` and `resolve` (src/spans.ts:317). Audit actually
  records `verify`, `create`, `commission`, `fork` too (verified via recordAudit call sites in
  squad-manager.ts) — those causal steps are never woven in.
- Render surfaces: `TraceDrilldown` span waterfall in `WorkflowGraphOverlay.tsx` (webapp), and
  `buildProvenance` (src/omp-graph/provenance.ts) → `Inspector.tsx` `TicketBody` (PLAN→AGENT→LAND only).

**Consequence:** the *durable survival* the epic's Verify demands is ALREADY met — receipts live in
`receipts/*.jsonl` and audit in `audit.jsonl`, both read fresh by `buildTrace` after a restart. The
real gaps are (a) fine spans are sampled away so `partial:true` shows, (b) the verify/spawn steps
aren't woven into the causal tree, (c) the reasoning/IO (transcript digest) isn't linked from a node,
(d) no local export sink so external tools see nothing by default.

## Decisions

### D1 — Sampling is per-*layer*, not per-run. Structural spans are never sampled.
The decision spine (run → verify → validate → land → observe) is **node-granularity**, never tool-
granularity. So: `RunAccumulator.snapshot` ALWAYS persists structural spans (`kind !== "tool"`);
only `tool` spans are subject to the sample ratio + `capSpans` budget. A new `sampled?: boolean` on
`RunReceipt` records "tool detail was dropped" — an honest signal distinct from "spine missing."

Consequence: `buildTrace`'s existing `partial` logic (`!r.spans?.length`) flips to `false` for every
finalized run automatically, because `r.spans` now always carries the structural spine. `partial`
keeps meaning "a receipt had NO spans at all" (legacy/pre-migration rows). A new `sampled` flag on
`TraceResponse` (any contributing receipt had tool detail dropped) carries the softer signal so the UI
can say "full spine · tool detail sampled" instead of the alarming "partial."

### D2 — Weave the audit-derived causal steps that already exist; forward-declare the ones that don't.
Extend `auditSpans` to weave: `verify` (kind `verify`), `create`/`commission`/`fork` (kind `spawn`),
plus the existing `land`/`resolve`, and — forward-compatible — `validate` (Epic 3) if present. Parent
each verify/land/resolve span under the **run span of its target agent** (by agentId), not the root,
so the tree reads run→verify→land instead of a flat sibling list. `dispatch`/`observe` have no clean
per-agent audit action today; do NOT synthesize them from the fuzzy automation-log (its events carry no
agentId) — the `create`/`commission` actor already answers "why spawned" (auto vs human). Automation-log
enrichment is explicitly out of scope for this epic (noted, not built).

### D3 — Reasoning/IO is reached through the digest, keyed by agentId.
The compact reasoning/IO already exists per agent at `digests/<agentId>.md` (src/digest.ts). Link it
by stamping a `digest` attr (= agentId) on the run span, and serve it at `GET /api/digest/:id`
(`readDigest` already exists). The UI turns any node whose `attrs.digest` is set into an "open
reasoning/IO" affordance. We do NOT inline prompts/outputs into span attrs (they stay redacted +
240-char capped, D per src/spans.ts:87) — the digest is the reachable, already-fenced payload.

### D4 — A durable local export sink is default-on; the queue retries before it drops.
Add `LocalFileExporter` writing NDJSON to `<stateDir>/traces.jsonl`, always included by
`traceExporterFromEnv` unless `OMP_SQUAD_TRACE_LOCAL=0`. Add bounded retry to `TraceExportQueue.drain`
(re-attempt a failed batch up to N times before counting it failed) so a transient collector blip
doesn't silently drop the batch. This makes "spans leave the daemon by default" true without requiring
an operator to stand up OTLP.

## The decision spine (the thing a reviewer walks)

```
issue ─▶ dispatch/spawn ─▶ run ─▶ verify ─▶ (validate) ─▶ land ─▶ (observe)
 │           audit:create      receipt   audit:verify   Epic 3   audit:land
 │           /commission       (spine     (woven, D2)             (already
 └─ featureId /fork (D2)        spans, D1)                         woven)
```
Reasoning/IO hangs off the `run` node via `attrs.digest` (D3). Everything is on disk before this epic
(receipts.jsonl + audit.jsonl); the local sink (D4) adds an external-tool-friendly copy.

## Non-goals
- No OTel SDK, no second span store beyond the NDJSON sink, no live streaming.
- No Epic-3 validator (this epic only forward-declares the `validate` span kind + audit action).
- No automation-log causal weaving (fuzzy; deferred).
- No change to span redaction/truncation (D3 keeps IO in the digest, not attrs).
