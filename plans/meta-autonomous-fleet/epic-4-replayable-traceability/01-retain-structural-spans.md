# Retain structural spans through sampling
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/spans.ts, src/receipts.ts, src/types.ts, tests/spans.test.ts

## Goal (what is built)
A finalized run receipt ALWAYS persists its structural spans (`kind !== "tool"`: run / node / subagent
and any lifecycle spans); only `tool` spans are subject to the sample ratio + `capSpans` budget. A new
`sampled?: boolean` on `RunReceipt` records "tool detail was dropped" so downstream can show an honest
"tool detail sampled" signal distinct from "spine missing." This is DESIGN D1 — it makes the decision
spine survive by construction, which flips `buildTrace`'s `partial` to `false` for finalized runs.

## Approach (how)
- `src/spans.ts:126 SpanCollector` — add a `snapshot` variant that returns only structural spans. Concretely
  add a method `structuralSnapshot(): Span[]` returning `this.spans.filter(s => s.kind !== "tool")`
  (deep-cloned like the existing `snapshot`, no cap needed — the spine is small). Keep the existing
  `snapshot(maxSpans)` (full, capped) unchanged.
- `src/receipts.ts:122 RunAccumulator.snapshot` — today it sets `receipt.spans` only when `includeSpans`.
  Change to: always compute `const tools = includeSpans` (the sampled vote). Build
  `receipt.spans = tools ? this.spans.snapshot(maxSpans) : this.spans.structuralSnapshot()`, and set
  `receipt.sampled = !tools && this.hasToolSpans()` (true when tool detail was dropped). Add a tiny
  `SpanCollector.hasToolSpans()` helper (`this.spans.some(s => s.kind === "tool")`). Note `this.spans`
  in RunAccumulator is the `SpanCollector` instance — access via the collector, not a private field.
- `src/spans.ts:262 shouldKeepSpans` stays the sampling oracle for the `tools` vote — no signature change.
- `src/types.ts` — add `sampled?: boolean` to the `RunReceipt` interface (near `spans?: Span[]`), with a
  one-line comment: "true when tool-level spans were tail-sampled out; the structural spine is still present."
- `tests/spans.test.ts` — the existing test asserts `sampledOut.spans` is `undefined` when sampled out
  (line ~20). Update it: `sampledOut.spans` now contains the structural spine (kinds `run`, `node`) and
  NO `tool` spans, and `sampledOut.sampled === true`. Keep the lossless-rollup assertions (`toolCalls`,
  `tokens`) unchanged.

## Scope boundary (what NOT to touch)
Do not change `traceSampleRatio`'s default (still 0.1 — tool spans stay sampled), `capSpans`, the
exporter, `buildTrace`'s `partial` computation (it flips for free), or any UI. Do not weave new audit
spans — that is concern 02. Do not touch redaction/attrs.

## Verify (concrete command + expected observable outcome)
`bun test tests/spans.test.ts tests/receipts.test.ts` — green. The updated case proves that with
`sampleRatio: 0, random: () => 0.99` the receipt still carries `run` + `node:plan` structural spans,
carries no `tool:read` span, and has `sampled === true`; and `bun test tests/spans.test.ts -t buildTrace`
shows `partial` is `false` for a receipt produced this way (structural spans present).
