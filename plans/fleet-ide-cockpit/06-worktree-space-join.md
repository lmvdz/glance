# C06 — worktree↔Space join

STATUS: done — merged in glance-desktop (99c6eb7…e2918ca); verified on main, 2026-07-21 reality audit
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
