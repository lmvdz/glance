# Weave verify/spawn audit into the causal spine
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/spans.ts, src/omp-graph/provenance.ts, src/types.ts, tests/spans.test.ts

## Goal (what is built)
`buildTrace` weaves the causal steps that audit already records — `verify`, `spawn`
(`create`/`commission`/`fork`), and the forward-declared `validate` (Epic 3) — into the tree alongside
the existing `land`/`resolve`, each parented under the **run span of its target agent** so the tree
reads run→verify→(validate)→land. `buildProvenance` gains a `verify` step so the Inspector ticket pane
shows it too. A `sampled` boolean is surfaced on `TraceResponse` (any contributing receipt had tool
detail dropped) so the UI can distinguish "full spine · tool detail sampled" from "partial." This is
DESIGN D2.

## Approach (how)
- `src/spans.ts:12 SpanKind` — add `"spawn"` and `"validate"` to the union (`"verify"` already exists).
- `src/spans.ts:310 auditSpans` — widen the filter from `a.action === "land" || a.action.includes("resolve")`
  to also match `verify`, `create`, `commission`, `fork`, `validate`. Map action→kind:
  `land→land`, `*resolve*→resolve`, `verify→verify`, `validate→validate`, `create|commission|fork→spawn`.
  Set each span's `parentSpanId` to the target agent's run span id when known. The run span id is
  reconstructable: for a receipt `r`, its run span is `${r.runId}:0` (see `fallbackRunSpan`, src/spans.ts:297)
  or the first `kind === "run"` span in `r.spans`. Build a `Map<agentId, runSpanId>` from `receipts`
  before mapping audit spans, and set `parentSpanId` from it (fall back to unset → attaches to root, as today).
- `src/spans.ts:333 buildTrace` — the audit spans loop (line 371) already `nodes.set(s.spanId, ...)`.
  Ensure the parent-attach loop (line 373) honors the new `parentSpanId` (it already reads
  `parentKeyByNodeKey`, but audit spans key by bare `spanId`, not `agentId:spanId`) — add the audit
  span ids into a lookup keyed by bare `spanId` and, when an audit span has a `parentSpanId` pointing at
  a run span, resolve it through `runNodeByAgent`/`nodes`. Keep it simple: since the run span node key is
  `${agentId}:${runSpanId}`, set the audit span's parent by looking up that composite key.
- `TraceResponse.sampled` — add `sampled: boolean` to the `TraceResponse` interface (src/spans.ts:56) and
  set it in the return (line 392) as `receipts.some(r => r.sampled)`.
- `src/omp-graph/provenance.ts` — `ProvenanceDoc` (line 30) and `buildProvenance` (line 99): read the
  audit log (`readAudit` from src/audit.ts, `stateDir` is already in scope) and, for the thread's agents,
  attach `doc.verify = { at, actor, outcome }` from the most-recent `verify` audit entry whose `target`
  is one of `doc.runs[].agentId`. Add the `verify?` field to `ProvenanceDoc`. Best-effort: wrap in
  try/catch like the existing plan lookup so a missing audit log never breaks provenance.
- `src/types.ts` — no new type needed beyond concern 01's `sampled` (already added); `TraceResponse` and
  `ProvenanceDoc` live in spans.ts / provenance.ts respectively.
- `tests/spans.test.ts` — extend the `buildTrace` case: feed a `verify` audit entry (target = the child
  run's agentId) and a `land` entry; assert the child run node has a `verify` child span and a `land`
  descendant, and that `trace.partial === false` / `trace.sampled` reflects the receipts.

## Scope boundary (what NOT to touch)
Do not synthesize `dispatch`/`observe` spans from automation-log (deferred — DESIGN D2). Do not build the
Epic-3 validator; only recognize a `validate` audit action if present. Do not touch the exporter, the
digest link (concern 04), or any webapp file (concern 05). Do not change sampling (concern 01).

## Verify (concrete command + expected observable outcome)
`bun test tests/spans.test.ts tests/trace-api.test.ts` — green, including the new assertion that a
`verify` audit entry appears as a child of its target's run node with `kind: "verify"`, and
`trace.partial === false` for a finalized spine. `bun run check` (tsc --noEmit) passes with the new
`SpanKind`s and `ProvenanceDoc.verify` field.
