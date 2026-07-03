# Fleet Pulse — the omp-graph renderer redesign

**Status:** concept locked 2026-07-02 · interactive mock in [`concept.html`](./concept.html)
(open directly in a browser — self-contained, synthetic data mirroring the real June 25 – July 2 week)
· live artifact: https://claude.ai/code/artifact/8a9e3aff-14eb-4bc1-8ca4-b3d56cf92c01

The Graph view becomes the **only Observe surface**: one full-viewport composition in the
Felton "ONE WEEK" / Data Double idiom. Automation, Fleet health, Heat map, and Activity
rhythm leave the nav; their useful cores become drill-downs *inside* this canvas.

## The composition (single spine)

Everything is one organism around a central day axis — no boxed lanes:

```
MILESTONES     marks hang from a top rail; per-day label stacks (all render, viewport-culled)
FLEET PULSE    cost heartbeat (line + stipple) OVERLAID with magma commit bars, one baseline
               + cumulative spend line (thin, monotonic, own scale)
               + BILLED·MODEL and VIA·HARNESS attribution bands + totals legends + plan chip
SPINE          fleet state band (thick ember = active) · day names · adaptive hour ruler · sun arcs
AGENT RUNS     duration pills, greedy row-packed (blue working / grey stopped / red error)
               + automation metronome ticks
SHIPPED·LOOPS  green DONE diamonds + loop notes hanging on leader lines, width-aware packing
```

Meaning of the split: **effort above the spine, outcomes below.**

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Idiom | Felton ONE WEEK / Data Double single-spine poster | user's reference boards; lanes fuse, don't stack |
| Chrome | none — no masthead, no footer; one 9px dossier line inside the SVG | "the graph is the only thing visible" |
| Color grammar | ember = activity, blue = runs/automation, red = needs-you, green = verdict; models fable-gold / sonnet-periwinkle / haiku-grey; harness omp-ember / codex-teal / claude-code-violet / hermes-rose | 4 roles + 2 confined categorical sets, no legend hunting |
| Texture | stipple fills (density = value), magma ramp + glow on hot bars | "data as material" from the reference boards |
| Canvas semantics | wheel = zoom (cursor-anchored, min 6h span), drag = pan, rAF rebuild, viewport culling | culling IS the virtual list — nothing capped, zoom reveals |
| Hover | zone-aware (x = instant, y = layer), exact-cursor ruler, highlight ring on every discrete hit, tooltip only for what's under the pointer | empty air says nothing |
| Coordinates | client→viewBox via `getScreenCTM().inverse()` | linear mapping breaks under letterboxing (real bug found twice) |
| Hit-testing | measured `getComputedTextLength()` extents, direction-aware for right-edge labels | fixed-width hitboxes fired past label ends (real bug) |
| Label collision | greedy interval packing per row, per zone | collision-free by construction, no "+N more" |
| Drill | click = drawer: commits→diff, DONE→plan→agent→proof→land pipeline, loops→scoped log, legend→cost matrix | the old panels live one click down, in context |
| Cost model | `spendMatrix[h][harness][model]` is the source of truth; model/harness views are marginals; $ bills to the model | harness→model is a hierarchy, not two dimensions |
| Plan worth | API-equivalent spend ÷ pro-rated subscription, chip + break-even moment in the cost drawer | "are we getting our money's worth" is a number |

## Multi-scale plan (weekly → yearly)

Ranges are bookmarks on the same canvas, not separate views:
- presets 1w · 2w · 1m · 1q · 1y set `view.span`; zoom stays continuous between them
- bins follow pixels (~3–6px/bar): hourly ≤2w, 6-hourly @1m, daily @1q, weekly @1y (`bars.binMs` already supports this)
- events degrade to density dots with counts; Δ-ranked "big" items keep labels longest
- captions change grain: day → week → month; sun arcs + hour ruler drop past ~2w
- session pills degrade to a concurrency ribbon past ~1m
- plan-worth chip pro-rates to the visible window

## Gap roadmap (next, in order)

1. **Needs-you layer** — imperative marks (blocked/land-ready) that don't wait to be hovered
2. **Thread tracing** — click a shipped ticket → its plan/run/commits/cost light up across all zones
3. **Failure marks** — verify/gate failures, catastrophes, idle burn back on the canvas
4. **Liveness** — WS streaming, advancing NOW edge, scheduled-work ghosts right of NOW
5. Baseline ghost of last period + records-as-deltas drawer
6. Cmd-K jump-to-entity; view state in URL
7. Multi-repo faceting; federation band

## Real-build mapping

- Renderer: replaces `webapp/src/omp-graph/GraphCanvas.tsx` internals; viewport state extends `useGraphView.ts`
- Data: all existing adapters suffice for the visualization; commits drawer = existing `/api/graph/commit`
- Backend gaps: `harness` field on receipts (1 field) · rates table for API-equivalent pricing (tokens already on receipts) · subscription config · a ticket-provenance endpoint (concern + receipt + land sha — data exists, no single query)
