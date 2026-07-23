# C07 — intervene pane

STATUS: done — merged in glance-desktop (99c6eb7…e2918ca); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/ (unit detail: why-stopped, diff-as-spine, steer)
BLOCKED_BY: C05

## Goal

Webapp-parity intervention inside the cockpit: unit detail shows why-stopped, the diff as the spine of the page, and a steer composer (line-comment → steer included) — so the operator never leaves the cockpit for the browser. Epic I later upgrades this from form to shared workspace; this concern earns parity first.

## Approach

- Recon the webapp's intervene view (memory: omp-squad-intervene-view — why-stopped + diff-as-spine + line-comment→steer, `openIntervene` flow) and the daemon endpoints it drives; consume the same endpoints.
- Diff rendering: reuse terax's existing diff components (it ships ai-diff/git-diff tab kinds) rather than porting the webapp's renderer — native idiom wins.
- Steer composer posts through the same API as the webapp; optimistic UI only where the webapp already does it.
- Wire C06's gesture into the detail header (open worktree) and C08's deep-link target at `fleet:unit/<id>`.

## Acceptance

- Live parity check against the webapp on the same seeded unit: same why-stopped, same diff hunks, steer round-trips and the unit resumes; line-comment steer lands with file:line context. Vitest on the steer payload mapping.
