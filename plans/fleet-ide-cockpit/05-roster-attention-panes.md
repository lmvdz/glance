# C05 — roster + attention panes

STATUS: open
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/ (roster view, attention queue, SSE subscription)
BLOCKED_BY: C04

## Goal

Fleet altitude, live: a roster of units (state, harness, repo, age, cost signal) and an attention queue (needs-input / error / gate-failed first), streaming over the daemon's SSE so state changes appear without refresh. This is the glance webapp's core content rendered natively.

## Approach

- Recon the daemon's actual SSE event shapes and the webapp's roster/attention components (omp-squad `src/web`/`webapp/`) — mirror the semantics, not the markup. Where the webapp derives state client-side, reuse the same derivation rules to avoid a second opinion of unit state.
- Attention queue ordering = the same priority the web-push lane uses (needs-human first). Row click = placeholder detail (C07 fills it); worktree affordance stubs to C06.
- Respect terax UI idioms (radix/shadcn `radix-luma`, Tailwind v4) — this must feel native to the cockpit, not a ported web page. Keep list virtualization in mind only if roster >100 units (don't pre-optimize).

## Acceptance

- Against a seeded scratch daemon: roster renders, a unit driven to needs-input jumps the attention queue live (no refresh); disconnect/reconnect of the daemon degrades and recovers visibly; vitest tests on the event-reduction store.
