# Epic C — Cockpit fork + native fleet module

STATUS: done — epic merged (see 00-meta close-out); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: glance-desktop (created by C01), omp-squad (daemon API additions where needed)
COMPLEXITY: architectural
SUB_PLAN: plans/fleet-ide-cockpit/

## Charter

Fork terax into `glance-desktop` (private repo, `upstream` remote, additive-only discipline) and build the native fleet module: daemon connection, roster + attention panes over SSE, worktree↔Space join (open a unit's worktree as a Space from the fleet pane), intervene pane at webapp parity, and native notifications deep-linking into fleet panes. At the end of this epic the suite exists: manage the fleet and dig into the nitty gritty in one window.

Fully expanded in `plans/fleet-ide-cockpit/` — concerns C01–C08. C01 (repo bootstrap) is the only concern that creates outward state (a private GitHub repo under Lars's account — authorized 2026-07-14, visibility stays private until Lars flips it).
