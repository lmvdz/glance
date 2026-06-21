# Implementation plan — Web race-board (concern 07, OMPSQ-8)

Scope: `src/web/index.html` ONLY. Zero new deps. No edits to `src/server.ts` or `src/types.ts` —
every consumed field (`kind`, `status`, `todo{done,total,active}`, `activity`, `lastActivity`,
`parentId`, `issue`) is already on `AgentDTO` (`types.ts:139-174`) and broadcast via WS `roster`/`agent`.

Verification gate: `bun run check && bun test`.

## Grounded anchors (current line numbers)
- View state + comment: `:207` (`let view = "project"`).
- Helpers to reuse: `esc` `:217`, `STATUSES` `:218`, `SPIN`/`spinFrame` `:230-231`, `ago()` `:232`,
  `isStalled()` `:233` (STALL_MS `:229`, concern-04 threshold), `ctxColor()` `:234`.
- Live spin/ago ticker (no re-render): `:236-240` — reuse `.spin` + `.agotime[data-ts]` so race lanes animate free.
- Routing: `pushRoute` `:378-385`, `applyRoute` `:386-394`.
- Nav rows: `renderNav` `rows[]` `:411-417`.
- `renderBody` dispatch: `:446-455`.
- `openQueue` `:466` (pattern for `openRace`); `openBoard` `:504`.
- Fan-out nesting reference (roots/children fold + `.acard.child`): `fillAgentGrid` `:786-789`,
  CSS `.acard.child` `:71`.
- Card status/stall/todo render reference: `:796-800`.
- `openAgent(id)` `:984`.
- `paletteItems()` `:818-825` (command-palette entry).
- Live-patch path: `refreshShell` `:1008-1015` (queue branch `:1010` is the mirror target).

## Steps

1. **View enum comment.** Update `:207` comment to include `"board" | "feature" | "queue" | "race"`
   (doc only; `view` is untyped JS). No behavior change.

2. **`openRace()`.** Add next to `openQueue`/`openBoard`: `function openRace(){ view="race"; selAgent=null; renderAll(); }`.

3. **Routing.**
   - `pushRoute` `:379`: prepend `view === "race" ? "#/race" :` to the hash ladder.
   - `applyRoute`: add `if (location.hash === "#/race") { view = "race"; selAgent = null; renderAll(); return; }`
     mirroring the `#/queue` line `:388` (race is client-only — no `loadFeatures()` call needed).

4. **Sidebar nav row.** In `renderNav` `rows[]` `:411-415`, add after the Queue row:
   `{ id:"race", ico:"⇶", lbl:"Race", sel: view === "race", on: openRace }`. Existing `:416-417`
   map/click wiring picks it up automatically.

5. **`renderBody` dispatch.** Add `if (view === "race") return renderRace(body);` near `:449`
   (before the project/agent fallthrough; race is roster-global, independent of `selProject`).

6. **`renderRace(body)`** — pure client-side fold over `agents.values()`:
   - **Header:** `.pv` + `.bvh` block like `renderQueue` `:477-478`: title "Race board", sub =
     agent count, a "← Back" button (`view="project"; renderAll()`).
   - **Ordering / fan-out nesting:** reuse the roots-then-children fold from `fillAgentGrid`
     `:786-789` but over ALL agents (not per-project): roots = agents whose `parentId` is unset or
     not in the live set; each root immediately followed by its `parentId`-children. Indent branch
     lanes (left margin + `↳ branch` marker, mirroring `.acard.child` `:71`).
   - **Per lane (one row per agent):**
     - Left: `badge b-<status>` (reuse `:68-69` palette) + name + `issue` line if present +
       `.spin` when `status==="working"` (reuses the `:236-240` ticker).
     - **Phase track** when `a.todo` exists: a segmented bar of `a.todo.total` cells, first
       `a.todo.done` filled, the current cell (index = `done`, clamped `< total`) highlighted and
       labelled `a.todo.active`. Color the filled run by `a.status` via the status palette vars
       (`--ok`/`--work`/`--input`/`--err`/`--stop`) — same colors `.b-*`/`.d.*` already use. Settled
       runs (`idle` after done / `error` / `stopped`) fill into the last cell with the matching color.
     - **No-rollup fallback** (`a.todo === undefined`, e.g. `--plain` omp-operators): render a single
       `badge b-<status>` pill lane labelled by `a.activity` (fallback `"—"`) — honest, no fake track.
     - **Liveness:** when `isStalled(a, Date.now())` (`:233`, the concern-04 STALL_MS threshold) show
       the `⏳ idle <ago>` `pill bad` cue (same markup as `:797`); always render the
       `.agotime[data-ts]` "<ago> ago" stamp so the `:239` ticker updates it live.
     - **Click → `openAgent(a.id)`** (`:984`), matching `fillAgentGrid` `:801`.

7. **CSS (minimal, reuse-first).** Add a small `/* race board */` block in the existing `<style>`
   (near the feature-board block `:81-98`) for the segmented track only: a flex row of cells with
   `var(--line)` borders, filled cells using the status color var, current cell outlined with
   `var(--accent)`, plus a lane wrapper + branch indent. No new framework, no new file, ~8-12 lines.
   Status colors come from existing `:root` vars `:9-11`; reuse `.section`, `.badge b-<status>`,
   `.pill bad`, `.spin`, `.agotime`.

8. **Live patch.** In `refreshShell` `:1010`, extend the queue branch to
   `if (view === "queue" || view === "race") { renderBody(); return; }` so the board re-renders on
   every `roster`/`agent` WS event (advancing bars live, no poll). Spin/ago tick via the shared
   `:236-240` interval already.

9. **Command palette (consistency).** Add `{ label: "Race board", hint: "per-agent pipeline", run: openRace }`
   to `paletteItems()` `:822` area, beside "Feature board". (Nice-to-have; keeps ⌘K parity.)

## Verification
- `bun run check && bun test` (the gate). No test files touched — this is a client-only HTML view;
  existing suite must stay green (proves no accidental edits to `server.ts`/`types.ts`).
- Manual sanity per concern-07 "Verify": spawn two `plan-implement` workflow agents → two segmented
  lanes advancing plan→approve→implement→verify with `todo.active` labelled; `fan-out` run → indented
  branch lanes under parent; stall one past STALL_MS → `⏳ idle`; drive one to `error` → red final
  cell; `--plain` agent → single status-pill lane; reload on `#/race` restores view.

## Ponytail notes
- Pure fold over already-broadcast fields; no server route, no SQLite mirror, no poll, no dep.
- Ceiling: column count keys off per-agent `todo.total` (assumes it reflects workflow stages).
  Non-workflow agents get a named status-only lane. Upgrade path: surface the engine's ordered node
  list on the DTO and key columns off that instead — out of scope here.
