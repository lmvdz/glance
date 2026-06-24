# Overview — omp-dashboard

Enterprise operator console: HumanLayer IA + piyaz skin + reskinned ompsq-55 primitives, parity with
`src/web/index.html`. Builds on branch `omp-graph-ui` (piyaz tokens + `lib/ws.ts` + `useSquad` +
force-graph + shell already present). Served behind the existing default-off `OMP_SQUAD_WEBAPP=1` seam;
`src/web/index.html` untouched until parity.

## Scope table
| # | Concern | Complexity | TOUCHES |
|---|---|---|---|
| 01 | Primitive kit (piyaz-skinned) | architectural | `webapp/src/components/ui/*`, `webapp/package.json` |
| 02 | App shell + IA + sidebar + view router | architectural | `webapp/src/App.tsx`, `components/layout/*` |
| 03 | Agent detail + live transcript (+ WS subscribe/transcript) | architectural | `lib/ws.ts`, `hooks/useSquad.ts`, `components/agent/*` |
| 04 | Approvals inbox + AnswerControls | architectural | `components/inbox/*`, `components/agent/AnswerControls.tsx` |
| 05 | Agent actions | architectural | `components/agent/*`, `lib/api.ts` |
| 06 | Spawn & new work | architectural | `components/spawn/*`, `lib/api.ts` |
| 07 | Command palette + keyboard nav | architectural | `components/palette/*`, `hooks/*` |
| 08 | Features board + feature detail | architectural | `components/features/*` |
| 09 | Audit view + liveness/attention signals | mechanical | `components/audit/*`, `lib/*` |
| 10 | omp-graph as a view | mechanical | `components/graph/*` (fold existing) |
| 11 | Verification + parity checklist + docs | mechanical | `webapp/src/**/*.test.ts`, `README.md` |

## Parity matrix (`index.html` capability → endpoint/command → concern)
| Capability | Endpoint / ClientCommand | Concern |
|---|---|---|
| roster / status / derived state | WS `roster`/`agent`/`removed` | have (`useSquad`) |
| live transcript + tool calls | WS `subscribe` + `transcript` | 03 |
| approvals: confirm/input/select/editor + host tools | `answer`; `PendingRequest` (`types.ts:30`) | 04 |
| prompt / steer | `prompt` | 05 |
| interrupt / kill / restart / remove | those `ClientCommand`s; `POST /api/command` | 05 |
| land / diff / subagents | `POST /api/agents/:id/{land,diff,subagents}` | 05 |
| spawn | `POST /api/spawn` (or `create`) | 06 |
| new / from-plan / auto feature | `POST /api/features{,/from-plan,/auto}` | 06 |
| attention queue (N waiting) | derived from `agent.pending[]` | 04 |
| board (stage lanes) + feature detail | `GET /api/features` (+ `/:id/pipeline,tickets`) | 08 |
| audit log + live | `GET /api/audit` + `audit` event | 09 |
| health | `GET /api/health` | 09 / topbar |
| command palette + slash commands | `commands` event (`CommandInfo` `types.ts:427`) | 07 |
| push notifications | `/api/push/*` | 09 |
| graph (new lens) | — | 10 |
| presence / leases / federation / deep Plane | `/api/{presence,leases,federation,plane/issues}` | **P3 deferred** |

## Dependency graph & shared-file analysis
`webapp/src/App.tsx`, `lib/ws.ts`, `hooks/useSquad.ts` are shared by many concerns → **SAME-FILE rule:
one owner of the webapp track, sequential, not parallel agents.** 01 (primitives) blocks all UI; 02
(shell) blocks views; 03 (transcript transport) blocks 04/05 (shared `AnswerControls`).

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `components/ui/*` primitives exist |
| 03 | 01, 02 | shell renders a detail route |
| 04 | 03 | transcript + detail render |
| 05 | 04 | `AnswerControls` exists (reused) |
| 06 | 02 | `lib/api.ts` exists |
| 07 | 02 | view router exists |
| 08 | 02 | features data (`buildGraphModel`) present |
| 09 | 02 | shell + topbar exist |
| 10 | 02 | `GraphView` exists (`omp-graph-ui`) |
| 11 | 03-10 | the above shipped |

## Batch order (one owner of the webapp track)
1. **Foundation:** `01 → 02`
2. **Operate (P1, sequential on shared agent detail):** `03 → 04 → 05`, then `06`
3. **Navigate (P2, mostly disjoint files):** `07 ‖ 08 ‖ 09 ‖ 10`
4. **Close:** `11` (verify + parity sweep + docs)

## Verification posture
Pure logic gets one runnable check each (inbox fold/sort, transcript reducer, `AnswerControls` value
mapping, palette fuzzy) via `cd webapp && bun run test`. UI verified by a smoke protocol against a
live daemon (`OMP_SQUAD_WEBAPP=1`, agents with `--approval always-ask`), walking the parity matrix
row by row. Existing gates (`tests/webapp.test.ts`, root `bun run check && bun test`) stay green.

## Status
11/11 done (2026-06-23) on branch `omp-graph-ui`. The `webapp/` is now a HumanLayer-shaped operator console (sidebar · list/detail · Cmd-K palette) at P1+P2 parity with `src/web/index.html`, piyaz-skinned, behind the default-off `OMP_SQUAD_WEBAPP=1` seam (live `index.html` untouched). P3 (federation/presence/leases/deep-Plane/push) deferred by design.

Gate green: root `bun run check` (tsc) clean; root `bun test` 492 pass / 0 fail (82 files); `cd webapp && bun run typecheck` + `bun run build` clean; `cd webapp && bun run test` 14 pass / 0 fail (graph-model 8 · fuzzy 4 · inbox 2); runtime smoke renders shell + palette with graceful WS degradation. Not merged to main.
