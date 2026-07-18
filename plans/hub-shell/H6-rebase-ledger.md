# upstream-rebase ledger + drift script (declare Epic M)

STATUS: open
PARENT: hub-shell

The hard divergence UPSTREAM.md anticipated. Newly owned/forked: App.tsx, WorkspaceSurface.tsx, useTabs.ts, header/Header.tsx (surgical). Kept pristine/rebasable: all of editor/terminal/explorer/source-control/git-history/preview/markdown/lsp/spaces/statusbar (demoted IDE never forks its internals). New code in fork-only dirs (app/hub, modules/fleet). Update UPSTREAM.md + scripts/upstream-drift.sh; budget manual App.tsx ports each rebase. TOUCHES: UPSTREAM.md, scripts/upstream-drift.sh. SIZE S. AFTER H0. VERIFY: git diff --stat upstream/main on the PR.
