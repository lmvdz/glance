# HubShell root — the room owns the viewport (SERIALIZED)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/App.tsx, webapp/src/components/hub/HubShell.tsx (new), webapp/src/components/hub/ChannelRail.tsx (new), webapp/src/lib/router.ts (new hash router), webapp/src/context/TaskContext.tsx, tests
BLOCKED_BY: 01
MODE: afk

## Goal
The app boots into the room: a new root layout owning the full viewport — channel rail (channels +
active work) on the left, conversation + hub composer on the right. Today's workbench views
(WorkspaceCockpit, TaskDetail, IntervenceView, graph, capabilities) are demoted to layer-2
routes/modes reached through doors and the rail — reachable, not the frame (B-F2; hub-shell H0
retargeted at webapp per Lars's directive). This is the SERIALIZED concern: everything in waves
1-3 rebases onto its App.tsx.

## Approach
1. Minimal hash router (the SPA has none; only #/review/:taskId exists ad hoc,
   TaskContext.tsx:303-306): routes for hub (default), channel/:id, and the demoted workbench
   views + IntervenceView (concern 12 needs deep-linkable doors that survive reload — A-C3).
2. HubShell: two-pane layout; rail lists channels (from concern 01 endpoints) + active work
   (state-grouped roster summary — the rail is a ratified standing entrance to depth); cold boot
   lands in #fleet.
3. Workbench demotion: existing view components mount unchanged under routes behind the hub —
   delete-not-port applies to NAV (no workbench tab bar in the hub frame), not to the components
   themselves; they are now doors' targets.
4. Composer mounts in the hub (existing Composer component; channel send wiring is concern 09;
   until then it can address the selected unit as today's AssistantChat does).
5. Craft: t3code two-pane grammar; consume concern 21's harvest list as it lands. DOM-free tests
   for route/state logic per webapp convention.
6. Informal Lars checkpoint on the first frame (non-gate, de-risks concern 23).

## Cross-Repo Side Effects
None.

## Verify
- Cold boot → hub with #fleet timeline region + rail; reload preserves route; old views reachable
  via routes and render unchanged.
- `bun run build` green (tsc --noEmit); existing component tests green.
- agent-browser screenshot of cold-boot frame attached to the PR for the checkpoint.
