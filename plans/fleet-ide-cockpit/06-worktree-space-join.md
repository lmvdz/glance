# C06 — worktree↔Space join

STATUS: in-review (glance-desktop#14)

## Reality notes (2026-07-15, glance-desktop#14)

The fleet→ground gesture. Key mechanics: create-or-focus needs App's useTabs (not a global store), so an App-registered handler singleton (mirrors lsp's setWorktreeOpener) — RosterView calls getWorktreeOpener()?.open(unit). `resolveOpenAction` PURE+tested (focus existing Space by root, else create — no dupes). `isLoopbackDaemon` gates the button (remote daemon's worktree is on another host). worktree field source-verified on the real DTO (squad-manager.ts:1765/1888 `worktree: p.worktree`). App.handleOpenWorktree mirrors handleNewSpace (create + newTab(worktree) + setActive). Gate: tsc/lint(103)/vitest 370/build green. GUI click-through not driven under WSLg (noted); all pieces verified in isolation + proven wiring pattern. No cross-lineage gauntlet (UI action, terminal at a daemon-provided cwd like any terax tab).
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/ (open-in-space action), spaces module store interaction
BLOCKED_BY: C05

## Goal

The suite's core gesture, in-app: from a roster/attention row, "Open worktree" creates-or-focuses a Space rooted at the unit's worktree — terminal, editor, git surface, one click from the fleet pane. (The CLI/daemon flavor of this gesture is bridge B02; this is the native flavor.)

## Approach

- Unit → worktree path comes from the daemon API (same resolution B02 uses — if the daemon lacks a clean endpoint by now, B02 has added it; consume, don't re-derive).
- Create `SpaceMeta {name: unit title, root: worktreePath, env}` via the spaces module's own store functions (never write terax-spaces.json directly from the fleet module — that seam is for external pre-seeding only); if a Space with that root exists, switch to it.
- Pre-seed the new Space's tabs: one terminal at the worktree root, and the git-diff surface if the unit has a dirty tree (mirror how spaces boot default tabs).
- Remote daemons: when the worktree path isn't local (daemon host ≠ cockpit host), disable the affordance with a copyable path + host hint — Epic M owns the SSH story.

## Acceptance

- Live: click from attention queue → Space opens rooted in the worktree, terminal cwd correct, git surface shows the unit's diff; clicking again focuses rather than duplicates; non-local daemon shows the disabled state. Store-level vitest tests for create-or-focus.
