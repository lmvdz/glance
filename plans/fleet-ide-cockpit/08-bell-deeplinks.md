# C08 — bell + deep links

STATUS: done — merged in glance-desktop (99c6eb7…e2918ca); verified on main, 2026-07-21 reality audit
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: mechanical
TOUCHES: src/modules/fleet/ (attention→notification wiring), notification plumbing reuse
BLOCKED_BY: C05

## Goal

Daemon attention events become native OS notifications (terax already ships tauri-plugin-notification and a notification bell for its detected agents); clicking one focuses the fleet pane on that unit (C07's detail). The cockpit user never watches the queue — the queue comes to them.

## Approach

- Subscribe the C04 connection store's attention transitions (same derivation as C05's queue — one source of truth) → `sendNotification` with a collapse tag per unit (mirror the daemon web-push `tag` semantics so repeated alerts replace, not stack).
- Click routing: terax is single-window — notification click focuses the window and routes the fleet pane to `unit/<id>`; reuse the bell/route plumbing in `src/modules/agents/` (`route.ts`, `NotificationBell.tsx`) if it generalizes, otherwise parallel it inside the fleet module (do not refactor upstream's module — rebase insurance).
- De-dup with bridge B01: if the unit's TUI is ALSO running in a cockpit terminal tab emitting OSC 777, suppress the doubled notification (collapse tag makes this nearly free).

## Acceptance

- Live: drive a seeded unit to needs-input with the cockpit backgrounded → OS notification appears, click focuses cockpit on that unit's detail; repeated alerts for one unit replace rather than stack; OSC-doubled case shows one notification.
