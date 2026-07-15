# C08 — bell + deep links

STATUS: in-review (glance-desktop#16, stacked on #15)

## Reality notes (2026-07-15, glance-desktop#16)

Native OS notification when a unit enters attention (input/error), even when the cockpit is backgrounded; click focuses the window + opens the unit detail. `attentionTransitions` PURE+tested (fire-once on entry, collapse-while-blocked via a module set, re-alert after recovery). `notifyAttention` uses the tauri notification plugin (mirrors terax's osNotify) with the unit id in `extra`; a once-registered `onAction` listener does the click→focus. Selection lifted out of RosterView into `fleetSelectionStore` so the click can focus from outside the tree. `tag` NOT on the plugin's Options (dropped; collapse set handles dedup). Stacked on C07 (#15). Gate: tsc/lint(103)/vitest 382/build green. OS delivery + click-focus not driven under WSLg — onAction desktop delivery varies by OS, so notification-firing is guaranteed and click is best-effort (noted). No gauntlet (local UI + OS notification).
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
