# `factory` automation loop (default OFF)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/factory.ts, src/scheduler.ts, src/factory-status.ts

## Goal
The tick that turns demand signals into queued `DemandSignal`s. A new automation loop, flag-gated OFF by default (mirroring `resident-planner`), that runs the daemon-side demand source, thresholds the signals into demands, and enqueues them (deduped).

## Approach
- Add `"factory"` to the `AutomationLoop` union in `src/types.ts` and register its arm/idle/moving state in `src/factory-status.ts`.
- Create `src/factory.ts`: on each tick, build the fabric snapshot + receipts, call `churnHotspots`/`flappingAgents`/`detectCollisions` from `src/demand-signals.ts` (Concern 01), map each above-threshold signal to a `DemandSignal` (`kind`+`targetArea`+`evidence`), and `enqueueDemand` (Concern 02). Thresholds mirror the existing boost-only/cold-start discipline (`MIN_SAMPLES`-style floors) so a single blip doesn't manufacture demand.
- **Gating:** the loop only arms when `OMP_SQUAD_FACTORY=1`. In DB/multi-tenant mode restrict to the root manager (follow the tenancy-vs-factory precedent — file-mode is the primary target).
- **Scheduler:** the loop itself is cheap (read + enqueue, no spawn). Register it in `src/scheduler.ts` like other automation loops; the spawn cost lands in Concern 04, which is where admission/budget apply. Do NOT spawn agents in this concern.
- Debounce: respect the Concern 02 dedup so re-ticks don't re-enqueue.

## Cross-Repo Side Effects
`AutomationLoop` union change ripples to any exhaustive switch over loop kinds (factory-status, automation-log labels, webapp automation panel) — update each to handle `"factory"`.

## Verify
- With `OMP_SQUAD_FACTORY` unset, the loop never arms (confirm via `factory-status`).
- With `OMP_SQUAD_FACTORY=1` against a repo with a synthetic churn hotspot, one tick enqueues exactly one `proceduralize`/`fix-churn` demand; a second tick enqueues nothing (dedup).
- `bun test` green; the loop appears in the automation log/panel.
