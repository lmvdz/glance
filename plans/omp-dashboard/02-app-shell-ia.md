# App shell + IA — sidebar + view router
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/App.tsx, webapp/src/components/layout/*

## Goal
The HumanLayer three-pane shell: a persistent left **sidebar** (Inbox · Agents · Features · Graph ·
Audit, with live counts), a center **list/detail** region, and an optional right **context** panel —
replacing the current two-mode `App.tsx`.

## Approach
- `Sidebar` — nav items with counts from `useSquad`: **Inbox** = agents in `input`/`error` (the
  attention number), **Agents** = roster size, **Features** = feature count. Active item styled with
  the accent; collapses to a drawer below `lg`.
- `view` state machine (`"inbox" | "agents" | "features" | "graph" | "audit"`), URL-hash synced so
  views are deep-linkable; shared `selectedId` for the open agent/feature.
- `PageShell` / `TopBar` — connection dot, `GET /api/health` verdict, theme toggle, global "+ New".
- `App.tsx` becomes the router shell: reads `useSquad`, renders sidebar + the active view + detail.
  The old `ViewTabs` Structure/Graph toggle is absorbed into the sidebar.

## Cross-Repo Side Effects
None. Reshapes `App.tsx`; later concerns mount their views into the shell's view slots.

## Verify
- Each sidebar item renders its view region; counts update live on `roster`/`agent` events.
- Selection persists across view switches; deep-link `#agents/<id>` restores selection.
- Below `lg`, the sidebar is a drawer and the detail takes the screen.

## Resolution
HumanLayer 3-pane shell: Sidebar (Inbox·Agents·Features·Graph·Audit + counts), TopBar, hash-synced view router; per-view containers. App.tsx is the stable shell. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0; `cd webapp && bun run build` + `bun run test` 14/0; runtime smoke OK).
