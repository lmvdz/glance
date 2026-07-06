# Surface the woven spine + reasoning link + honest sampling label
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/WorkflowGraphOverlay.tsx, webapp/src/lib/dto.ts, webapp/src/omp-graph/Inspector.tsx, webapp/src/omp-graph/types.ts

## Goal (what is built)
The `TraceDrilldown` span waterfall renders the newly woven spine (`verify`/`spawn`/`validate` kinds),
turns any node whose `attrs.digest` is set into an "open reasoning/IO" affordance that fetches
`/api/digest/:id`, and replaces the alarming "sampled — partial" pill with an honest signal: nothing when
the spine is complete, "tool detail sampled" when `sampled` is set, "partial" only when a receipt truly
had no spans. The Inspector ticket pane (`TicketBody`) gains a VERIFY step from the provenance doc. This
renders the backend work of concerns 02 (`sampled`, woven kinds, `verify`) and 04 (`attrs.digest`,
`/api/digest`).

## Approach (how)
- `webapp/src/lib/dto.ts` — `TraceSpanKindDTO` (line ~252) add `'spawn' | 'validate'`. `TraceResponseDTO`
  (line ~284) add `sampled?: boolean` with a one-line comment mirroring src/spans.ts.
- `webapp/src/components/WorkflowGraphOverlay.tsx`:
  - The `partial` pill (line ~193) currently shows whenever `data?.partial`. Change the badge logic to:
    show nothing when `!data.partial && !data.sampled`; show a muted "tool detail sampled" chip when
    `data.sampled && !data.partial`; keep the amber "partial" chip only when `data.partial`. Update the
    doc-comment at line ~181 accordingly.
  - `TraceSpanRow` (line ~239): when `node.attrs?.digest` is set, render a small button/link after the
    span name — "reasoning" — that opens the digest. Add a `<DigestPeek agentId={node.attrs.digest} />`
    lightweight component that on click `apiFetch('/api/digest/' + encodeURIComponent(agentId))`,
    `.text()`s the markdown, and shows it in a collapsible `<pre>` (raw markdown is fine — it is already
    fenced/redacted; do NOT dangerouslySetInnerHTML). Import `apiFetch` from `../lib/api`.
  - Give `verify`/`spawn`/`validate`/`land`/`resolve` kinds a distinguishable dot color in
    `SPAN_STATUS_DOT`'s sibling (there is currently only a status dot) — add a small `KIND_TINT` map or
    reuse `node.kind` text (already shown at line ~243) so the woven steps read as a spine, not noise.
- `webapp/src/omp-graph/types.ts` — `ProvenanceDoc` (line ~221) add
  `verify?: { at: number; actor: string; outcome: string }` mirroring the backend field from concern 02.
- `webapp/src/omp-graph/Inspector.tsx` — `TicketBody` (line ~49): between the AGENT steps and the LAND
  step, render a VERIFY `<Step>` when `doc.verify` is present (color `#E8B24A`, k=`VERIFY`,
  v=`${doc.verify.outcome}`, s=`${fmtWhen(doc.verify.at)} · ${doc.verify.actor}`). Falls through silently
  when absent (older receipts). Keep `normalizeProvenance` (webapp/src/omp-graph/normalize.ts) tolerant —
  if it strips unknown fields, add `verify` passthrough there.

## Scope boundary (what NOT to touch)
No backend changes (concerns 02/04 supply the data). Do not add a markdown renderer dependency — show the
digest as pre-formatted text. Do not restyle the whole Inspector; only add the VERIFY step and the pill
logic. Do not touch the FleetPulse canvas geometry or the cost/hour panes.

## Verify (concrete command + expected observable outcome)
`cd webapp && bun run build` (tsc --noEmit && vite build) — passes with the new DTO fields. Live: open the
FleetPulse Inspector on a landed ticket → "Trace on canvas" / open the TaskDetail WorkflowGraphOverlay,
and confirm the span waterfall shows `run → verify → land` rows, a "reasoning" affordance on the run node
that expands to the digest markdown, and NO "partial" badge on the finalized spine (at most a muted "tool
detail sampled" chip). The ticket pane shows a VERIFY step between AGENT and LAND.
