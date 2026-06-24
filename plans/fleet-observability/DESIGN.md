# Design: unified fleet execution observability — trace tree + pluggable export

> Source: `/research https://github.com/mastra-ai/mastra` → concepts #3 (span hierarchy + sampling +
> tags/metadata) and #4 (pluggable exporters). We borrow the **pattern** — a span/trace tree, ratio +
> always-on-error sampling, allowlisted tags, an exporter interface with OTel first — and **reject the
> framework**: no `@opentelemetry/*` / `@mastra/*` dependency, no new runtime, no new store. Every span
> rides the seams omp-squad already has (`receipts`, the `audit` log, the frame stream, `StageEvent`).
>
> This is the Pillar-3 "trace tree + export" half (North-Star G2). The other Pillar-3 halves are owned
> elsewhere and are **out of scope**: reasoning harvest + pattern→opportunity (`plans/agent-context-fabric/`,
> agent `PlanAgentContextFabric`), quality scorers (`plans/best-of-n-selection/`), durable workflow resume
> (`plans/durable-workflow-resume/`).
>
> Hardened by an adversarial design pass over the five attack surfaces the charter named: sampling
> correctness, N-agent cost/storage, receipts-vs-new-store, trace-id propagation across the
> daemon → detached agent-host → inner-omp boundary, and export failure isolation. Findings are tagged
> **RTC-F#** (correctness / crash / partial-failure) and **RTS-F#** (scope / scaling / simplicity) and
> folded in below. Several reshaped the design (tail sampling, embed-in-receipt, derive-land-from-audit,
> no live firehose, fetch-not-SDK).

## Problem (verified in source)

omp-squad accounts for a run but cannot **trace** one. The facts:

- **A per-run rollup exists, a tree does not.** `RunAccumulator` (`src/receipts.ts:35-122`) sums
  tokens/cost/tool-calls/files for one `agent_start..agent_end` window and `snapshot()`s a flat `RunReceipt`
  (`src/types.ts:245-263`), persisted one JSONL line per run (`appendReceipt`, `src/receipts.ts:161-174`).
  There is no span, no parent edge, no per-phase timing — `toolTally` is a histogram, not a tree.
- **The lifecycle is observable but uncorrelated.** The daemon already sees every phase: `agent_start`,
  `tool_execution_start` (`src/squad-manager.ts:1524-1530`), workflow node boundaries as
  `StageEvent`/`tool_execution_start{toolName:"stage"}` (`src/workflow/executor.ts:84-91`), the subagent
  tree (`src/subagents.ts`, in-memory `Map`), `agent_end → finalizeRun` (`src/squad-manager.ts:1533-1540`),
  and `land`/`resolve` as audit records (`recordAudit`, `src/squad-manager.ts:717-722,778-779,1638-1646`).
  Nothing **stitches** these into one navigable tree with cost rolled up.
- **No sampling, no export.** Receipts persist every run unconditionally; there is no way to bound
  fine-grained detail under N-agent fan-out, and no seam to ship traces to an enterprise stack
  (OTel/Langfuse/Datadog).
- **Cross-run assembly is already the house style.** `features` are *fully derived at read time* from plan
  dirs + roster + git (`src/types.ts` `FeatureDTO`, "Phase 1: fully DERIVED at read time"). The trace tree
  follows the same pattern: stored facts are per-run; the tree is assembled on read.

Acceptance bar (North-Star Pillar 3): *a full feature trace renders as one navigable tree with cost rolled
up*; *a deliberately-stuck agent is flagged with a correct cause*; cost/token/throughput is *queryable and
exportable* per agent/feature/operator/org; a *pluggable export seam* (OTel/Langfuse/Datadog) exists.

## Approach (one paragraph)

A **span/trace tree assembled at read time over the stores that already exist.** A run-local `SpanCollector`
(sibling to `RunAccumulator`) turns the frame stream + `StageEvent`s into a small span subtree and attaches
it to the `RunReceipt` as two **additive optional fields** (`traceId`, `spans`) — no new store, no new file.
A **tail sampler at `finalizeRun`** decides whether to persist the fine `spans[]` (ratio, default 0.1) but
**always keeps a run that errored** and **always keeps the receipt rollup** (cost/tokens are never sampled).
`land`/`resolve` spans are **derived from the existing `audit` log** (no new writes). The trace tree is a
**pull** (`GET /api/trace/:id`) that groups receipts by `traceId`, stitches the cross-agent forest via the
existing `parentId` chain, folds in audit-derived lifecycle spans, and rolls up cost — **no live span
firehose**. A **pluggable `Exporter` seam** (OTLP/HTTP JSON via the existing ssrf-guarded `fetch`; Langfuse
& Datadog adapters) drains a **bounded in-memory queue off the hot path**, so an exporter outage drops spans
(counted, logged) but **never stalls the fleet**.

## The span model

```ts
// src/spans.ts (new)
export type SpanKind = "run" | "node" | "tool" | "subagent" | "verify" | "land" | "resolve";

export interface Span {
  traceId: string;        // feat:<featureId>  (multi-agent feature)  |  run:<agentId>:<runId> (standalone)
  spanId: string;         // <runId>:<seq>     deterministic, run-local monotonic — no random/crypto id
  parentSpanId?: string;  // intra-run tree edge; cross-run edges are stitched at read via receipt.parentId
  name: string;           // "run" | "node:plan" | "tool:read" | "subagent:<agent>" | "land" | "resolve"
  kind: SpanKind;
  startedAt: number;
  endedAt?: number;
  status: "ok" | "error" | "running";
  attrs?: Record<string, string>;  // ALLOWLISTED tags only (model, repo, feature, operator, org, issue, branch)
}
```

- **Trace id derivation (free, from existing metadata).** `traceId = featureId ? \`feat:${featureId}\` :
  \`run:${agentId}:${runId}\``. A fan-out branch already carries `featureId`, so all branches of a feature
  share one trace. **No cross-process id propagation** (see RTC-F4).
- **Span id.** `\`${runId}:${seq}\`` — a per-run monotonic counter. Unique within a run; cross-run
  uniqueness comes from the trace grouping. (OTLP needs hex ids → C5 hashes the string id to 8/16 bytes at
  export; no crypto dep — a stable non-cryptographic hash.)
- **Tree shape.**
  - intra-run (in the receipt): `run` → `node:*` (workflow stages) → `tool:*` / `subagent:*`.
  - cross-run (at read, C4): a synthetic `feat:` root → each agent's `run` span attaches under its parent
    agent's `run` span (via `receipt.parentId`) or under the root.
  - lifecycle (at read, C3/C4): `land` / `resolve` spans derived from the `audit` log, attached to the
    `feat:` root.

## Storage decision — extend `receipts`, never a new store (RTS-F1)

| Option | Verdict |
|---|---|
| Dedicated spans DB / OTel collector store | **Rejected** — a second accounting store beside `receipts` is a defect (charter: "a second mechanism beside an existing one is a defect"). Heavy, new dep, new RLS surface. |
| Sibling `spans/<traceId>.jsonl` written live | **Rejected for v1** — write amplification under N-agent fan-out is the cost we are trying to bound; doubles the persist path. Kept as the documented upgrade path for live-durable cross-crash spans. |
| **Embed `spans?` + `traceId?` in `RunReceipt` (chosen)** | One extra serialize on the line `finalizeRun` already fsyncs. Reuses `appendReceipt`/`readReceipts` and the DB `usage.data` JSON column verbatim. Trace assembled at read like `features`. Zero new files for storage. |

The fields are **purely additive optional** — `readReceipts`/`receiptPath`/`RunReceipt.filesTouched`
signatures are preserved, so `PlanAgentContextFabric`'s `import { readReceipts, RunReceipt }` stays green
(coordinated over IRC; recorded in `00-overview.md`).

## Sampling — never drop an error (RTC-F1, the #1 safety bar)

The decision is made at the **tail** (`finalizeRun`), where the run's terminal status and any errored child
span are already known — so "always keep errors" is correct *by construction*, never a head-time gamble:

```
finalizeRun(run):
  receipt = run.snapshot()          # rollup (cost/tokens/toolTally) — ALWAYS persisted, never sampled
  keep = run.status == "error"
      || run.spans.any(s => s.status == "error")   # any failed node/tool/gate forces keep
      || Math.random() < ratio                      # OMP_SQUAD_TRACE_SAMPLE, default 0.1
  receipt.spans = keep ? cap(run.spans) : undefined  # only the fine detail is sampled
  appendReceipt(receipt)            # cost/throughput rollup is lossless regardless of `keep`
```

- **The receipt rollup is never sampled** → cost/token/throughput accounting (the queryable/exportable
  acceptance bar) is always lossless. Sampling governs only the *span tree detail*.
- **Always-on-error is non-configurable** — there is no env to turn off keeping errors. It is a safety
  invariant, not a knob (RTS-F5).
- **Per-run span cap** (`OMP_SQUAD_TRACE_MAX_SPANS`, default 500): a runaway 10k-tool run sheds *oldest tool
  spans first*, keeping the `run`/`node`/`verify`/`land`/`resolve` backbone + all `error` spans. `toolTally`
  already holds the full lossless tool histogram (RTS-F3).

## Export seam — pluggable, isolated from the hot path (RTC-F6, the named-hard problem)

```ts
export interface Exporter { name: string; export(spans: Span[], res: Resource): Promise<void>; }
```

- **OTel first**: `OtlpExporter` emits **OTLP/HTTP + JSON** via the existing ssrf-guarded `fetch` — a stable,
  documented wire format. **No `@opentelemetry/*` dependency** (RTS-F4). `LangfuseExporter` / `DatadogExporter`
  are thin adapters mapping `Span[]` onto their HTTP ingest.
- **Off the hot path**: `finalizeRun` persists the receipt (durable), then `void`-enqueues the kept spans to
  a **bounded ring queue**; a separate drain loop calls exporters with a per-call timeout. The hot path
  **never awaits an exporter** — same fire-and-forget shape as the existing `void this.store.appendUsage(...)`
  and scout calls (`src/squad-manager.ts:1592,1604-1608`).
- **Outage = drop, never stall** (RTC-F7): the queue is bounded (drop-oldest + a `dropped` counter); a
  hung/erroring exporter has its failures counted + rate-limit-logged and its spans dropped. The receipt is
  on disk regardless → re-export is a backfill (upgrade path). No durable retry queue in v1.
- **Security boundaries kept** (RTC-F8/F9): exporter endpoints are operator-supplied URLs → every fetch
  passes the existing `ssrf` guard (`src/ssrf.ts:142` `checkVisionUrl`/`isBlockedIp`). Spans are
  `redact()`ed (`src/redact.ts:29`) before they enter a receipt, and `attrs` is an **allowlist** of
  known-safe keys — never raw frame contents.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Where spans live | Embed `traceId?`+`spans?` in `RunReceipt`; assemble tree at read | New spans store; sibling JSONL | Reuse the persist/read/DB path verbatim; mirror `features` read-time derivation (RTS-F1). |
| Sampling timing | **Tail** decision at `finalizeRun` | Head/start-time ratio | Tail knows the outcome → "keep all errors" is sound by construction; head sampling *cannot* guarantee it (RTC-F1). |
| What sampling governs | Only `spans[]` detail; rollup always kept | Sample the whole receipt | Cost/throughput must stay lossless (acceptance bar). |
| Error keep switch | Non-configurable invariant | Env-tunable | A knob that can drop errors defeats the safety bar (RTS-F5). |
| Trace-id propagation | Daemon-side, derived from `featureId`/`parentId` | Inject `traceparent` into agent-host→omp env | The daemon already receives every frame; no cross-process propagation needed (RTC-F4). Env injection is the upgrade path for omp's *own* OTel correlation. |
| land/resolve spans | **Derive from the `audit` log at read** | New span writes in `land()`/`resolve` | The audit log already records `land`/`resolve` with actor/target(feature)/outcome/at — pure reuse, zero new write path (RTS-F6). |
| Live updates | **Pull** (`GET /api/trace/:id`) = finalized receipts ∪ in-flight collectors | Live `{type:"span"}` WS push per span | Per-span push is the transcript firehose the charter forbids; one pull gives the full current tree (RTS-F2). |
| OTel transport | OTLP/HTTP **JSON** via `fetch` | `@opentelemetry/*` SDK | JSON-OTLP over the existing ssrf'd fetch is not a hard problem; the SDK is the documented edge upgrade (RTS-F4). |
| Export coupling | Bounded ring queue, fire-and-forget drain | Synchronous export in `finalizeRun`; durable retry queue | An exporter outage must never stall the fleet; durable retry is YAGNI when the receipt is the source of truth (RTC-F6/F7). |
| Per-org isolation | Reuse the `usage`/`audit` RLS (`withOrg`) | New trace RLS | Spans ride the receipt → `appendUsage` already RLS-scopes; trace query routes through `withOrg` in DB mode (RTC-F10). |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| In-memory spans lost on daemon crash mid-run | known ceiling | The receipt is *also* only written at run end → consistent; a resumed successor run re-spans. `ponytail:` upgrade = periodic span flush to a sibling JSONL. |
| One errored branch keeps full spans; OK siblings follow ratio | known ceiling | Every branch's *rollup* (cost/status/toolTally) is always persisted → the tree always shows all branches; you drill into the red one. Upgrade = cross-run coherent sampling (keep all if any errors). |
| Tool spans approximate concurrency (no `tool_execution_end` frame exists) | minor | omp main-agent tools are sequential within a turn → close a tool span on the next `tool_execution_start` / `message_end` / `agent_end`. `ponytail:` upgrade = real end frames / overlapping spans if omp emits them. |
| Embedding a 500-span tree bloats one receipt line | minor | Per-run cap (RTS-F3); `toolTally` keeps the lossless histogram; ~tens of KB/line is fine for JSONL + a TEXT column. |
| Exporter endpoint = SSRF / secret leak | significant | ssrf guard on every fetch; `redact()` + allowlisted `attrs` before persist/export. Not simplified away. |
| DB-mode trace query scans `usage.data` JSON | minor | C4 adds a nullable indexed `trace_id` column (one migration) so per-org/per-trace query is real SQL; file mode groups `readReceipts` in-memory by trace. |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| RTC-F1 sampling drops an error trace | critical | Tail decision at `finalizeRun`; error ⇒ force-keep; rollup never sampled (C02). |
| RTC-F2 in-memory spans lost on crash | known ceiling | Consistent with receipt-at-end; resumed run re-spans; documented (C01). |
| RTC-F3 errored branch vs OK siblings sampling | known ceiling | All rollups always persisted; drill into the red branch; cross-run coherent sampling = upgrade (C02/C04). |
| RTC-F4 trace-id across daemon→agent-host→omp | critical-looking, dissolved | Trace assembled daemon-side from existing metadata; no propagation needed; env `traceparent` = upgrade for omp's own OTel (C01). |
| RTC-F5 `finalizeRun` fires twice (agent_end+exit) | significant | Span-attach + export-enqueue go INSIDE the `run.finalized` guard (`src/squad-manager.ts:1586`) → exactly once (C01/C05). |
| RTC-F6 exporter outage stalls the fleet | critical | Fire-and-forget bounded-queue drain; hot path never awaits an exporter (C05). |
| RTC-F7 queue grows unbounded under burst | significant | Bounded ring, drop-oldest + counter; best-effort (C05). |
| RTC-F8 spans leak secrets on persist/export | critical | `redact()` + allowlisted `attrs` before the span enters a receipt (C01); export ships already-redacted spans (C05). |
| RTC-F9 SSRF via exporter URL | critical | ssrf guard on every exporter fetch (C05). |
| RTC-F10 cross-tenant trace read (DB mode) | significant | Spans ride the RLS-scoped `usage` row; trace query via `withOrg` (C04). |
| RTS-F1 new heavy span store | critical | Embed in `RunReceipt`; assemble at read (C01/C04). |
| RTS-F2 live span broadcast = firehose | significant | No live push; pull `GET /api/trace/:id` = receipts ∪ in-flight collectors (C04). |
| RTS-F3 per-tool spans explode storage | significant | Per-run span cap, shed oldest tool spans, keep backbone + errors (C02). |
| RTS-F4 OTel SDK dependency | significant | OTLP/HTTP JSON via existing `fetch`; SDK = documented upgrade (C05). |
| RTS-F5 sampling config sprawl | minor | One ratio env + a master off-switch; error-keep non-configurable (C02). |
| RTS-F6 land/resolve spans = scope creep | minor | Derived from the audit log (no new write); small isolated concern (C03). |
| RTS-F7 cost rollup = new analytics engine | significant | Read-time fold over receipts; DB `select sum() group by` per org; no materialized view (C04). |
| Verified-safe (do NOT over-fix) | — | `finalizeRun` already idempotent; `appendReceipt` already fsync'd + torn-tail tolerant; `usage.data` already stores receipt JSON; `redact`/`ssrf` already exist — reuse, don't rebuild. |

## Open Questions
None blocking. Two deferred-by-decision: live-durable cross-crash spans (sibling JSONL flush) and cross-run
coherent sampling (keep all feature spans if any branch errors) are explicit upgrade paths, out of scope for
v1.
