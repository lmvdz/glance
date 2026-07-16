# Intervene teaching surface: delta bullets, surprise tap, deterministic reading order
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 05
TOUCHES: webapp/src/components/IntervenceView.tsx, webapp/src/lib/diff-order.ts (new), webapp/src/lib/attention.ts, src/server.ts

## Goal
The intervene moment becomes a teaching moment: the unit's recorded mental-model deltas render above the diff spine, each with a one-tap "surprised me" chip that feeds the fog, and the diff hunks are ordered as a story (definition-before-use) instead of path order.

## Approach
1. **Delta bullets above the diff** (`IntervenceView.tsx`): fetch the bound feature's decisions filtered to `source:"model-delta"` (reuse however the view/agent DTO exposes feature decisions today; if not exposed, add them to the existing agent/feature GET payload in `src/server.ts` rather than a new route). Render ≤3 bullets with their evidence anchors as clickable links that scroll to that file's diff section. Empty state: nothing (no placeholder nagging).
2. **Surprise tap**: each bullet gets a small "surprised me" chip → `reportAttention({kind:'surprise', repo, file: <first evidence file>, agentId})`. Concern 01's store already max-merges `surprise` into the seen map; fog treatment: concern 03's `computeFog` treats a `surprise` event as *raising* that file's effective change mass (add a `surpriseBoost` — one surprise counts as +8 changes, constant tested) — surprise means the operator's model diverged there. (Add the boost in this concern via a small extension to `computeFog`'s input if concern 03 landed without it — coordinate through the seen-map's byViewer/kind data or a parallel surprise map in `src/attention.ts`; keep it a pure, tested change.)
3. **Deterministic reading order** (`webapp/src/lib/diff-order.ts`, new, pure): port the ndrstnd ordering shape (Apache-2.0, adaptation with attribution comment): token-scan symbol definitions vs uses across the diff files (minus a keyword set), layer precedence (config/schema → lib → server/manager → UI), per-layer topological sort, graceful fallback to current order on cycle or contradiction. Feed it the existing `AgentFileDiff[]`; use the result to order the diff spine. Toggle chip "story order / path order" defaulting to story.
4. All logic pure and tested (`diff-order.ts`, surprise-boost math); `IntervenceView.tsx` stays wiring.

## Cross-Repo Side Effects
None.

## Verify
`cd webapp && bun test && bunx tsc --noEmit` green: ordering (definition-before-use property on a synthetic diff, cycle fallback, layer precedence), surprise boost math. Root `bun test` green if server payload extended. Manual: intervene on a unit with recorded deltas → bullets render, evidence links scroll, surprise tap raises the file in `/api/fog` debt.
