# upstream-rebase ledger + drift script (declare Epic M)

STATUS: cancelled
PARENT: hub-shell

The hard divergence UPSTREAM.md anticipated. Newly owned/forked: App.tsx, WorkspaceSurface.tsx, useTabs.ts, header/Header.tsx (surgical). Kept pristine/rebasable: all of editor/terminal/explorer/source-control/git-history/preview/markdown/lsp/spaces/statusbar (demoted IDE never forks its internals). New code in fork-only dirs (app/hub, modules/fleet). Update UPSTREAM.md + scripts/upstream-drift.sh; budget manual App.tsx ports each rebase. TOUCHES: UPSTREAM.md, scripts/upstream-drift.sh. SIZE S. AFTER H0. VERIFY: git diff --stat upstream/main on the PR.

## Resolution
Superseded 2026-07-22 by plans/the-room — the thesis (chat as root, expert surfaces as modes)
is absorbed as HubShell-in-webapp (the-room DESIGN.md, decision "Shell"); the method (executing
inside glance-desktop) is retired with the fork (unused, non-working — Lars directive). See
plans/the-room/07-hubshell-root.md for the successor concern.
