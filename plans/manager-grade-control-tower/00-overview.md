# Overview — manager-grade Control Tower

STATUS: partial
PRIORITY: p0
REPOS: omp-squad

> 2026-07-01 reconcile (was blanket "done"; 2026-06-30 audit + re-verify): backend concerns 01/05
> and the observability surfaces (04, now living as AutomationPanel/FleetHealthPanel/HeatPanel in
> the replaced shell) are real. 02 is `diverged` (assistant-ui rejected; goal met by the custom
> transcript instead) and 03 is `open` (shell-navigation/issue-workspace never built). See the
> per-concern notes.

> WIP gate: scanner showed 7 existing open plan dirs / 30 open concerns. Proceeded because the operator explicitly asked to parallelize `/plan` agents on this Control Tower overhaul.

## Goal

Turn the current webapp from a pretty-but-thin dashboard into the North-Star manager-grade IDE: glance at the fleet, be interrupted only on typed exceptions, inspect rich OMP/TUI-equivalent execution, and steer from any page through a contextual assistant-ui surface.

## Verified landscape

- The daemon already has the right spine: `SquadEvent` + `ClientCommand`, with all mutations through `applyCommand` and transcript append through `SquadManager.append()`.
- The current web transcript contract is lossy: `TranscriptEntry = { kind, text, ts }`. Tool calls become `{"activity":"stage: Implement"}` in `webapp/src/lib/omp-thread.ts` because backend drops tool args/results/status at `src/squad-manager.ts` `tool_execution_start` handling.
- The local assistant-ui wrapper is capable: `ThreadPrimitive`, `ComposerPrimitive`, grouped tool calls, reasoning, markdown, queue, dictation/speech, action bars, branch picker, slash-command/mention adapters exist in installed `@assistant-ui/react`.
- `App.tsx` special-cases `view === "console"`, removing Sidebar/DetailRail and causing the “no way back” complaint.
- `webapp/src/lib/heat-data.ts` is fake: May dates, Go paths, hardcoded arrays. This contradicts the repo and the North-Star correction that real heat must come from `receipts.filesTouched`, not phantom `dal/context`.
- `DashboardPagesView.tsx` contains many placeholder/disabled pages: profiles group by model string; governance/settings/conflicts say “Awaiting API”; Fleet Health is four tiles instead of observability.
- Missions use a slide-over `DetailPanel`; the desired product is a route-level issue workspace with task detail, plan context, comments, trace, and a page-aware ad-hoc agent.

## Scope table

| # | Concern | Priority | Complexity | TOUCHES |
|---|---|---|---|---|
| 01 | Rich OMP event + transcript contract | p0 | architectural | `src/types.ts`, `src/squad-manager.ts`, `src/rpc-agent.ts`, `src/agent-driver.ts`, `src/server.ts`, `src/tui.ts`, `webapp/src/lib/dto.ts`, `webapp/src/lib/omp-thread.ts`, tests |
| 02 | assistant-ui Control Tower thread replacement | p0 | architectural | `webapp/src/components/views/ConsoleView.tsx`, `webapp/src/components/assistant-ui/*`, `webapp/src/lib/omp-thread.ts`, `webapp/src/lib/assistant-text.ts`, `webapp/src/hooks/useSquad.ts`, tests |
| 03 | App shell navigation + full issue workspace | p0 | architectural | `webapp/src/App.tsx`, `webapp/src/components/layout/*`, `webapp/src/components/views/FeaturesView.tsx`, `webapp/src/components/project/*`, `webapp/src/components/workbench/DetailRail.tsx`, tests |
| 04 | Real observability + heat data surfaces | p0 | architectural | `src/server.ts`, `src/squad-manager.ts`, `src/receipts.ts`, `src/types.ts`, `webapp/src/components/views/HeatmapView.tsx`, `DashboardPagesView.tsx`, `webapp/src/lib/heat-data.ts`, tests |
| 05 | Actionable needs-input inbox + error recovery | p1 | architectural | `src/types.ts`, `src/squad-manager.ts`, `webapp/src/components/views/InboxView.tsx`, `webapp/src/components/agent/AnswerControls.tsx`, `webapp/src/lib/inbox.ts`, tests |
| 06 | Real agent profiles + model/runtime routing view | p1 | architectural | `src/intake.ts`, `src/smart-spawn.ts`, `src/types.ts`, `src/server.ts`, `webapp/src/components/views/DashboardPagesView.tsx`, spawn/console model selectors, tests |
| 07 | Governance/federation/onboarding truth pass | p1 | architectural | `src/server.ts`, `src/federation.ts`, `webapp/src/components/views/NetworkView.tsx`, `DashboardPagesView.tsx`, onboarding components, tests |
| 08 | Verification, docs, parity smoke | p0 | mechanical | `README.md`, `docs/*` if present, root/webapp targeted tests |

## Dependency graph

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | — | — |
| 02 | 01 | Enriched transcript entries exist in `src/types.ts` and web dto mirrors them. |
| 03 | 02 | Reusable Control Tower thread/runtime exists; issue route can embed page-aware agent. |
| 04 | 01 | Rich receipt/session fields available; otherwise heat/trace cards would still be fake. |
| 05 | 01, 02 | Pending requests can render as rich assistant-ui/tool-action parts. |
| 06 | — | Existing `intake`/`smart-spawn` profile seam confirmed; no second spawn path. |
| 07 | 04 | Health/governance/federation surfaces know what data is real vs missing. |
| 08 | 01-07 | All behavior/UI changes landed. |

## Batch order

1. **Contract foundation:** 01 and 06 can run in parallel only if `src/types.ts` ownership is assigned to 01 first; otherwise run 01 → 06.
2. **Control surface:** 02 after 01.
3. **Workspace + data:** 03 and 04 can run in parallel after 02/01 if `App.tsx` ownership goes to 03 and `DashboardPagesView.tsx` ownership goes to 04.
4. **Exception/governance surfaces:** 05 and 07 after 02/04.
5. **Close:** 08.

## Shared-file analysis

- `src/types.ts` is touched by 01/04/05/06. Concern 01 owns shared wire schema; later concerns consume it.
- `webapp/src/lib/dto.ts` mirrors `src/types.ts`; update in the same commit as 01, not separately.
- `webapp/src/App.tsx` belongs to 03; no other concern changes routing until 03 lands.
- `DashboardPagesView.tsx` is currently a catch-all placeholder file; 04 owns data dashboards, 06 owns profiles section, 07 owns governance/onboarding. Split sections into smaller components before parallelizing implementation.
- `webapp/src/lib/omp-thread.ts` belongs to 02 after 01 establishes schema.

## Verification posture

- Pure contract tests: fake manager/driver frames for message ids, duplicate user prompts, tool start/update/end, pending create/cancel/answer, session state polling.
- Web unit tests: `buildOmpMessages`, `ConsoleView`, `InboxView`, route shell, heat aggregation, dashboard loading/empty/error.
- Targeted typechecks/tests only during implementation; no `dev` or `build` unless explicitly requested.
- Manual smoke after implementation: `OMP_SQUAD_WEBAPP=1` with one live agent that runs a staged workflow, a bash/tool call, a pending input, an errored/recovered agent, and a Plane task detail route.

## Out of scope

- Building a new agent runtime or replacing OMP. North Star says OMP/ACP/Flue are runtimes; omp-squad is the governing substrate above them.
- Scraping TUI ANSI output.
- Implementing full `fleet-observability` spans/export here; this plan consumes its future endpoints and provides honest placeholders meanwhile.
- New dependencies unless an existing assistant-ui/Radix/motion primitive cannot cover the UI.
