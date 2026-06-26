# Real agent profiles + model/runtime routing view
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/intake.ts, src/smart-spawn.ts, src/squad-manager.ts, src/server.ts, webapp/src/lib/dto.ts, webapp/src/components/views/DashboardPagesView.tsx, webapp/src/components/spawn/NewWork.tsx, webapp/src/components/views/ConsoleView.tsx, tests/*, webapp/src/**/*.test.ts

## Goal

Replace the fake “profile” page that groups agents by model string with real named profiles: persona/system overlay, runtime/model policy, approval mode, capability grants pointer, and memory pointer — through the existing `intake`/`smart-spawn` seam.

## Approach

- Do not build a second spawn path.
- Add a minimal versioned profile file/read model if not already present:
  - id/name/description
  - runtime kind (`omp-operator`, ACP, Flue/workflow when applicable)
  - default model spec / escalation policy label
  - approval mode
  - capability grant names (read-only display until the capabilities model lands)
  - memory pointer/digest scope (read-only display until profile memory lands)
- Add manager/server read endpoint for profiles and effective model/runtime options. The existing `/api/models` remains model inventory, not profile inventory.
- Spawn/Control Tower selectors should show profile first, model second. Selecting a profile passes through `intake`/`smart-spawn`; model override remains an advanced override if the profile permits it.
- Profiles page displays real profiles and live usage: active agents, model/runtime, cost/tokens/tool calls from receipts, last status/error, commands/tool inventory when available.
- If no profiles are configured, show “using default omp profile” with a CTA/command hint, not a bogus model bucket.

## Cross-Repo Side Effects

None.

## Verify

- `/api/profiles` (or chosen endpoint) returns default profile plus any configured profile files.
- Spawning with profile uses existing `intake`/`smart-spawn` routing and still respects WIP/admission gates.
- Profiles page no longer renders `openai-codex/gpt-5.5 (4 agents)` as a profile.
- Model selector still pulls live OMP model list and `OMP_SQUAD_MODELS` fallback, but labels it as model override.
