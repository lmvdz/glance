# Agent overlay — the "both layered" feature
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/graph/ForceGraph.tsx, webapp/src/lib/graph-model.ts

## Goal
The omp-graph differentiator: overlay live `AgentDTO` presence on the feature each agent is
executing. The dependency graph stays the legible base layer; agents annotate it with status rings,
counts, and a hover card — without becoming first-class simulation nodes.

## Approach
1. **Input.** `ForceGraph` gains an optional prop `agentsByFeature?: ReadonlyMap<string, AgentDTO[]>`
   (from concern 04). The simulation/topology is unchanged — this is a **render-pass overlay** keyed
   by node id, so it never perturbs layout or the position cache.
2. **Per-node ring.** In the canvas draw loop (after the node body, before labels), for any node with
   agents, draw an outer status ring whose color = the agent's `AgentStatus` mapped to the existing
   theme palette: `working`→accent indigo (animated/pulsing via the existing tick clock),
   `input`→`--color-progress` amber (the attention color), `error`→`--color-cancelled` red,
   `idle`→muted, `starting`→dashed. Multiple agents → concentric/segmented arcs (cap at 3, "+N").
3. **Attention priority.** If any agent on a node is `input` or `error`, that color wins the ring +
   gets a subtle glow (reuse `--shadow-glow-*` semantics in canvas as an additive halo) so blocked
   work pops at a glance — mirrors omp-squad's "route attention, don't demand it" principle
   (`plans/squad-ui-ux/00-overview.md`).
4. **Count badge.** Small mono badge on the node corner: agent count (e.g. `2`), drawn in the label
   pass using `--font-mono`.
5. **Hover card.** Extend the existing hover tooltip (or port `GraphHoverCard`) to list the node's
   agents: name · `activity` · `todo` (done/total) · `contextPct` bar · pending count. Pull straight
   from `AgentDTO` (`src/types.ts:167`).
6. **graph-model touch.** Ensure `agentsByFeature` only includes agents whose `featureId` resolves to
   a rendered node; decide unassigned-agent handling (v1: surface a count in the top bar, do NOT add
   floating nodes — keeps the base graph clean). `ponytail:` no floating agent nodes; add later if
   operators want to see unattached agents in the canvas.

## Cross-Repo Side Effects
None outside `webapp/`. Edits the lifted `ForceGraph.tsx` (concern 03) + `graph-model.ts` (concern 04).

## Verify
- Spawn 2 agents on one feature → that node shows a `2` badge + status ring; drive one to
  `needs-input` → ring flips amber + glows; kill one → ring goes red.
- Idle fleet (agents finished) → rings go muted, base dependency graph still fully legible.
- Hover a node with agents → card lists each agent's activity/todo/context; redraw stays smooth
  under a stream of `agent` events (coalesced to one rAF/tick via `needsRedrawRef`).

## Resolution
ForceGraph gained an agentsByFeature overlay pass: per-node status ring + count badge, input/error attention color + glow, agent summary in the hover tooltip. overlay.ts holds the helpers. Pure render pass, layout untouched. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
