# Web race-board — lane-per-agent pipeline view
STATUS: planned
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/web/index.html
PLANE: OMPSQ-8 — https://app.plane.so/inkwell-finance/browse/OMPSQ-8/

## Goal
Give the operator a **race-board**: one horizontal lane per agent, the workflow's phases as
columns, each card advancing left→right with a per-phase sub-progress bar — so with N parallel
agents you see *who is where in the pipeline and who has stalled* at a glance. Today the web has a
status grid (`fillAgentGrid`, `index.html:799`) and a feature **kanban** keyed by `FeatureStage`
(`renderBoard`, `:508`), but no per-agent pipeline-position view. Concept (not code) borrowed from
github.com/teamkit-ai/kanbun; everything it needs is already on the wire.

## Why this is cheap (data already broadcast)
Workflow stage rollup is mapped into the DTO server-side: the executor's `rollup` (`{label,status}[]`)
becomes `RpcSessionState.tasks` (`workflow-driver.ts:155`) → `AgentDTO.todo {done,total,active}`
(`squad-manager.ts:889`). So per agent we already have, with **no server change**: `kind`, `status`,
`todo.done/total/active` (= phase position + current phase label), `activity`, `lastActivity`
(liveness), `parentId` (fan-out branch → parent workflow), `featureId`, `issue`
(`AgentDTO`, `types.ts:139-175`). Rides the existing WS `roster`/`agent` events — no poll, no DB.

## Approach
1. **New view `"race"`** alongside `"project" | "agent" | "board" | "feature" | "queue"`
   (`renderBody` `:446-455`). Add a `renderRace(body)`; dispatch a `view==="race"` branch in
   `renderBody`, and in the live-patch path `refreshShell()` (`:1009-1014`) mirror the `queue`
   branch (`:1010`) so the board re-renders on every `roster`/`agent` event.
2. **Sidebar nav row.** Add a "Race" row to `rows[]` in `renderSidebar` (`:411-416`), ico e.g.
   `⇶`, `sel: view==="race"`, `on: openRace`. Add `openRace()` next to `openBoard()` (`:504`).
3. **Routing.** Add `#/race` to `pushRoute` (`:378-385`) and `applyRoute` (`:386-389`), mirroring
   the `#/queue` deep-link wiring.
4. **The lanes.** In `renderRace`, fold `agents.values()`:
   - **Lane per agent**, fan-out branches (`a.parentId`) indented under their parent workflow row
     (reuse the nesting the roster already does).
   - **Phase track** = a segmented bar of `a.todo.total` cells with `a.todo.done` filled, the
     current cell highlighted and labelled `a.todo.active`. Color the filled run by `a.status`
     (working / input / error / idle) reusing the existing status palette (`badge b-<status>`,
     `--input`) — no new CSS framework.
   - **No-rollup agents** (plain omp-operators have `todo===undefined`): render a single status
     pill lane labelled by `a.activity` — an honest fallback, not a fake track.
   - **Liveness:** a stall cue when `status==="working"` && `now - a.lastActivity` exceeds the same
     threshold concern 04 introduced (reuse that helper), plus the `ago()` timestamp per lane.
   - **Settled runs** (`idle` after done / `error` / `stopped`) settle into the last cell with the
     right color — like kanbun's final column.
   - Click a lane → `openAgent(a.id)` (`:801`).
5. **Styling.** Reuse `.section`, `.badge b-<status>`, `--input`, `ago()`, `ctxColor`, and the
   vanilla-DOM string building used elsewhere in the file. No new dependency.

ponytail: pure client-side fold over `todo` / `status` / `lastActivity` / `kind` / `parentId`
already broadcast — no server route, no SQLite mirror, no poll, no new dep. Ceiling: the column
model assumes `todo.total` reflects workflow stages; non-workflow agents get a status-only lane
(named). Upgrade path: if a richer phase taxonomy is wanted, surface the engine's ordered node list
on the DTO and key columns off that instead of per-agent `todo.total`.

## Cross-Repo Side Effects
None. No `src/server.ts` / `src/types.ts` change — every field consumed already exists on
`AgentDTO` and is already broadcast.

## Verify
- `omp-squad up --no-tui`; spawn two `--workflow plan-implement` agents on a repo. Open `#/race`:
  two lanes, each a segmented track advancing plan→approve→implement→verify, the current phase
  labelled and filled cells matching `todo.done/total`; answering the approve gate advances the bar
  live (no refresh).
- Spawn a `--workflow fan-out` run → branch agents appear as indented lanes under the parent.
- Let one agent sit `working` past the stall threshold → its lane shows the stall cue; drive one to
  `error` → its lane settles red in the last cell.
- Spawn a plain agent (`--plain`) → single status-pill lane, no fake track.
- Deep-link: reload on `#/race` restores the view. Gate: `bun run check` + `bun test` green.

## Resolution
(filled on close)
