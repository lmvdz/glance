# Brief — omp-graph UI: clone piyaz's force-graph workspace into `webapp/`

Research output from `/research https://github.com/FrkAk/piyaz`. The user likes piyaz's UI
and wants to clone it, then adapt it for **omp-graph** — a graph view of the omp-squad fleet.

## What piyaz is

FrkAk/piyaz (108★, **AGPL-3.0**): an agentic workspace that renders a task/dependency
knowledge graph for coding agents. Stack: Next.js 16 (RSC) · React 19 · Tailwind v4 · Motion ·
TanStack Query · SSE · Drizzle. The signature UI is a **dual-mode workspace**: a "Structure"
task list and a "Graph" force-directed dependency canvas over the same data, with a detail panel.

## The three clonable layers (ranked by value × portability)

| Layer | piyaz source | Portability |
|---|---|---|
| **Canvas force-graph engine** | `components/graph/{graphConstants,useForceSimulation,ForceGraph,GraphControls}` (~3 kLOC) | High — pure client, domain-agnostic prop interface `{projectId, tasks, edges, selectedNodeId, …}` |
| **Design tokens** | `app/globals.css` `@theme` block (Raycast near-black palette, atmosphere, glow, scrollbars) | High — pure CSS custom props, read by both DOM and canvas via `getCanvasTheme()` |
| **Dual-mode shell** | `TwoPanelLayout`, `WorkspaceGraphView` (Motion slide-over), `ViewTabs` | High — generic React, needs `motion` |

Skip: piyaz's 40 hand-rolled primitives (`components/shared/*`) — webapp already has shadcn.
Skip: RSC / server actions / SSE / Drizzle — webapp is a Vite SPA over the SquadServer WebSocket.

## Abstracted concepts (transferable patterns)

- **A — Domain-agnostic force-graph.** Nodes need only `{id,title,status,tags}`, edges `{source,target,type}`. Maps to any node/edge domain.
- **B — One token source for DOM + canvas.** `@theme` CSS vars + `getCanvasTheme()` reading `getComputedStyle` keeps Tailwind classes and the `<canvas>` painter in lockstep, incl. light/dark via a `MutationObserver` on `<html class>`.
- **C — Position cache outside React.** `Map<graphId, Map<nodeId,{x,y}>>` module global → layout survives remounts (critical: omp-squad's graph remounts on every roster WS event).
- **D — Size-derived force config + perf tiers.** `deriveForceConfig(N,E)` + high/mid/low tier knobs (pre-tick count, alphaDecay, flow-dots/halo toggles) keep small graphs cosy and large graphs readable.
- **E — State-machine camera w/ inset.** `cold→settling→settled→focused` drives fit/focus; `rightInset` keeps the focused node clear of the detail slide-over.
- **F — Slide-over over full-bleed canvas.** Selecting a node adds a Motion layer instead of reflowing — graph stays the primary surface.

## omp-graph domain mapping (decided: "both layered")

- **Base task layer** = `FeatureDTO` (`src/types.ts:132`) — `stage` (planned→issues-created→in-progress→review→diverged→landed→done) maps to piyaz's lifecycle palette. **Dependency edges** from `IssueRef.blockedBy[]` (`:67`) where issues are attached; **relates** from shared `planDir`/repo.
- **Agent overlay** = `AgentDTO` (`src/types.ts:167`) pinned to its `featureId` (`:207`); status ring from `AgentStatus` (working/idle/input/error), with `activity`/`todo`/`contextPct` in the hover card.

## Decisions (from the research gate)

- **License: accept AGPL.** Lift the graph engine verbatim; `webapp/` becomes AGPL-3.0 with attribution to FrkAk/piyaz.
- **Domain: both layered.** Task/dependency graph as the base, agents overlaid on the feature each is executing.

Build-vs-buy: **borrow the engine source** (the d3-force canvas tuning is genuinely hard and the
user accepted AGPL); **recreate everything else** (tokens are CSS; shell is generic React).
