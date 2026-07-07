# Daemon-side demand source
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/insights.ts, src/demand-signals.ts

## Goal
Make the fleet's demand signals readable from the daemon. Today `churnHotspots`, `flappingAgents`, and `detectCollisions` live only in `webapp/src/lib/insights.ts`, which imports React at module top (`useEffect`/`useState` used in the same file) — the daemon cannot import them. Extract the pure ranking functions into a React-free `src/`-importable module and have the webapp re-import from it, so both sides compute demand from one source of truth.

## Approach
- Create `src/demand-signals.ts` exporting the pure functions and their return types, with **no React import**: `churnHotspots(heat, runs, limit)`, `flappingAgents(agents, minCount)`, `detectCollisions(runs, agents)`, and their result types (`ChurnHotspot`, `FlappingAgent`, `Collision`).
- These functions currently take DTO-shaped inputs the daemon already produces before the webapp derives from them (heat/governance payloads, run receipts, agent DTOs). Confirm each input is available daemon-side from `src/fabric.ts` / receipts / the heat payload; where a function reaches into a webapp-only shape, adapt its signature to the daemon primitive rather than porting the React-coupled shape.
- In `webapp/src/lib/insights.ts`, delete the moved function bodies and re-export from the new module (`export { churnHotspots, flappingAgents, detectCollisions } from '../../../src/demand-signals'` or the repo's configured path alias). Leave the React `useState` history hook and `attentionItems` (which is webapp attention UI, not a demand signal) in place.
- Keep the extraction pure and total (no throwing) — it will run on every factory tick.

## Cross-Repo Side Effects
None outside the repo. Webapp and daemon now share `src/demand-signals.ts`; the webapp bundle imports a daemon-path module — verify the webapp build (Vite/bundler) resolves it (the repo already shares `src/` types into the webapp elsewhere; follow that precedent).

## Verify
- `grep -n "react" src/demand-signals.ts` returns nothing.
- Daemon-side: a scratch `bun` script imports `churnHotspots` from `src/demand-signals.ts` and runs it against a `buildFabricSnapshot` + receipts without pulling React.
- `bun test` green; webapp typecheck/build green; the webapp still renders churn/flapping/collision views unchanged (behavior-preserving refactor).
