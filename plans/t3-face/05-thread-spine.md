# Thread spine — the always-visible unit/session sidebar

STATUS: done
PRIORITY: p0
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 03, 04
TOUCHES: src/modules/fleet/spine/* (new), src/app/App.tsx, src/app/components/WorkspaceSurface.tsx, src/modules/command-palette/commands.ts

## Goal

The cockpit has an always-visible left sidebar of units and casual/adoptable sessions — grouped by project/daemon, with roll-up group headers and per-row attention pills — and a detail pane adjacent to it, not a tab-buried drill-down that replaces the list. This is the structural change that makes the app *be* t3code-shaped rather than merely t3-painted.

## Approach

Reference: `/tmp/t3/components_AppSidebarLayout.tsx`, `components_Sidebar.tsx` (row/header render regions), `components_Sidebar.logic.ts` (grouping/sort/roll-up helpers — these pure helpers port; the status cascade is deferred to concern 07, which consumes the daemon ladder). Preserve MIT notice on any substantially-copied file.

Today: selecting a unit does `if (selected) return <IntervenePane…>` inside `RosterView` — a modal drill-down. Change the topology:

1. **New `src/modules/fleet/spine/`**: a `ThreadSpine` sidebar (units + adoptable sessions as rows, grouped by project then daemon/host; group headers with collapse + a roll-up attention dot in the chevron slot per t3's crossfade idiom) and a `FleetLayout` that renders spine-left + detail-right (the existing IntervenePane as the detail pane), replacing the roster→intervene swap. Use t3 row idioms: `h-6 sm:h-7 px-2`, active `bg-accent/85`, selected `bg-primary/15`, hover-reveal actions via named groups with pointer-events swap, truncating title, trailing meta slot (cost/host badge/worktree button).
2. **Attention rendering v1**: render the fleet's EXISTING client attention state (`fleetAttention.ts` `attentionUnits()`/`attentionReason()` + status dots) as the pills — do NOT introduce a new ranking. Concern 07 swaps the source to the daemon ladder and deletes any client ranking. The spine's pill component is built now so 07 is a data-source change, not a re-layout.
3. **Prewarm**: fetch the transcript for the top-N attention units on spine mount / roster poll (t3's `SIDEBAR_THREAD_PREWARM_LIMIT = 10`) so switching is instant — the roster already polls, so this is cheap. Detail switch on a prewarmed unit must paint < 100 ms (concern 13 budget).
4. **Registration** (the declared upstream-conflict seams — run `scripts/upstream-drift.sh` after): the spine is the fleet detail surface, so keep the existing `FleetTab` but have it mount `FleetLayout`; if a persistent (non-tab) placement is wanted, add it behind the existing fleet command-palette entry. Minimize edits to App.tsx/WorkspaceSurface/commands.ts to registration only.
5. Detail pane keeps take-over/hand-back, why-stopped, lease overlay, steer composer — unchanged behavior, now adjacent to the list.

Keep every batch shippable: the spine renders real units from `FleetClient` on day one; no dependency on concerns 06/07 to be visible and useful.

## Cross-Repo Side Effects

None (renders existing daemon endpoints).

## Verify

- Live (scratch daemon + ≥3 real/synthetic units across ≥2 projects): list and detail visible simultaneously; selecting a unit updates the detail pane without unmounting the list; group headers roll up attention; collapsing a group preserves a roll-up dot.
- Prewarmed unit switch < 100 ms to painted transcript (video capture, concern 13).
- `scripts/upstream-drift.sh` shows only registration-line edits to the 3 seam files.
- `pnpm lint && check-types && vitest run && build` green.

## Resolution

Shipped as glance-desktop draft PR #33 (branch `t3face/05-thread-spine`, off merged main). FleetLayout (sidebar + adjacent detail, siblings — list never unmounts on selection); ThreadSpine with project→daemon groups, roll-up crossfade headers, attention pills (v1 = existing client state from fleetRoster; 07 swaps to daemon ladder), prewarm-seeded transcript store. Absorbed+deleted RosterView + AdoptableSessions. **Zero seam-file edits** (FleetPane was the only RosterView call site) — no upstream conflict added. On-token (grep zero), 538 tests, lint/types/build green.

**NOT MERGED** — taste centerpiece; live render (does it feel like t3code, <100ms prewarmed switch, WebKitGTK) is Lars's "yes THIS" gate + concern 13. Render locally: `cd` the worktree, `pnpm tauri dev` (WSLg window). Spec corrections found: attention source is fleetRoster (not fleetAttention); the 3 declared seam files weren't needed.
