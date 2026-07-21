# buildTaskClassMatrix + honest observability surface
STATUS: closed — 2026-07-21: the reland of orphan-merged PR #71 (85aa218) silently DROPPED TaskClassMatrixPanel.tsx, leaving the backend + /api/graph/task-class live with zero renderers; panel restored from history and mounted in the Daily view (collapsed scoreboard section) by the surface-invisible-observability PR.
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: new src/omp-graph/task-class-matrix.ts (mirror attribution.ts:26-63), src/server.ts (new taskClassPayload, near usagePayload/heatPayload/attributionPayload), webapp/src/lib/insights.ts + a new panel component
BLOCKED_BY: 04-independent-difficulty-signal
VERIFY_BLOCKER: task-outcome rows carry model (C01) + difficulty (C04) + outcome (C03)

## Goal
Ship the maintainer's long-open "task-class × model rubric scoreboard" — truthfully. Aggregate the joined outcome log into a `task-class × model` matrix and render it as an **explicitly labeled, non-causal observability surface** ("what the router did and what happened after"), not a decision oracle.

## Approach
1. **Pure aggregator `buildTaskClassMatrix(rows, range, opts)`** (sibling to `buildAttribution`, `src/omp-graph/attribution.ts:26-63`; pure over `readTaskOutcomes()` — no I/O). Output cells keyed `taskClass → model → { n, mergeRate, medianCostUsd, costCoveragePct, nWithCost, medianConfidence, inRunReworkRate }`.
   - **merge-rate** = landed / (landing-kind roster count for that cell) — denominator from C02, not from surviving rows.
   - **median-cost** surfaced *with* `costCoveragePct` and `nWithCost`; never a median over a mostly-null column (most fleet runs are subscription-priced → `costUsd` null). If coverage is low, show it grayed with the coverage caveat.
   - **rework** = in-run fixup churn (C04), labeled in-run.
   - Apply a **minimum-sample gate** (reuse the spirit of smart-spawn's `MIN_SAMPLES`): cells below N render as "insufficient data", never as signal.
2. **`taskClassPayload(manager, url)` in `src/server.ts`** alongside the existing payload fns; route it (e.g. `/api/graph/task-class`) following the `attributionPayload` pattern.
3. **Surface in `webapp/src/lib/insights.ts` + a new panel.** The panel MUST carry a visible label: *"Observational — rows are grouped by the router's own choices; not yet a causal comparison of models."* Show n per cell; gray sub-threshold cells. This is the honesty guardrail that lets the scoreboard ship before exploration (D1) exists.

## Cross-Repo Side Effects
Webapp gains a panel + a payload type mirror (follow existing `UsagePayload`/`HeatPayload` DTO mirror pattern). No backend contract broken.

## Verify
- With a handful of real landed/rejected units across ≥2 models (route a few via C06 or `set-model` to seed a second model), load the panel and confirm cells show n, merge-rate, and the coverage-qualified cost.
- Confirm sub-threshold cells render "insufficient data", not a misleading 100%/0%.
- Confirm the non-causal label is present and the rework column says in-run.
- `/verify` the panel end-to-end in the running webapp (`OMP_SQUAD_WEBAPP=1`), not just a unit test.

## Resolution
Closed — `buildTaskClassMatrix` (src/omp-graph/task-class-matrix.ts) is pure, mirrors `buildAttribution`. Denominator = deduped union of `SquadManager.landingRosterRouting()` (roster members, incl. units that died before any land row) ∪ outcome-row agentIds (incl. reconciled units evicted from the roster); guarded with a throw if mergeRate > 1. `costCoveragePct` denominator is rows-in-cell (not the full roster-inclusive `n`) so subscription-priced-null coverage isn't conflated with never-landed roster members. `inRunReworkRate` is over LANDED rows only. `MIN_SAMPLES = 3` gates `insufficientData`.

Correctness catch: `AgentDTO` does NOT carry `routing` (only `PersistedAgent` does, per C03) — rather than touching all 5 `AgentDTO` literal construction sites in squad-manager.ts for a field only this one aggregator needs, added `SquadManager.landingRosterRouting()` alongside `landingRoster()`, reading `rec.options.routing` directly off the same `isLandingUnit`-filtered population.

`taskClassPayload` (src/server.ts) is NOT nested under the `resolveGraphRepo`-gated `/api/graph` block like `attributionPayload` — `TaskOutcomeRow` has no `repo` field (a routing decision isn't per-repo), so registered as its own flat route `/api/graph/task-class`, fleet-wide like `/api/usage`/`/api/heat`.

Webapp: `TaskClassMatrixPayload`/`TaskClassCell` mirror in `webapp/src/lib/insights.ts`; new `webapp/src/components/TaskClassMatrixPanel.tsx` (mirrors HeatPanel's PanelShell/Callout/SectionCard layout), wired into `AppView`/`App.tsx`/`WorkbenchPane.tsx` nav (Observe section, both expanded and collapsed rails) as "Task-class × model". The mandatory non-causal label is a permanent (non-collapsible) `Callout` at the top of the panel body, always rendered before the matrix.

13 new tests (tests/task-class-matrix.test.ts) hit the denominator-union/mergeRate-cap/reconciled-row/cost-coverage/min-samples/in-run-rework invariants directly. `bun run check` (tsc) clean; webapp `tsc --noEmit` + `vite build` clean; full suite 1577/1577; webapp suite 553/553.
