# 04 — Visibility panels: the loop's two invisible signals get a face

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
TOUCHES: webapp/src/context/TaskContext.tsx, webapp/src/App.tsx, webapp/src/components/WorkbenchPane.tsx, webapp/src/components/ (new DailyPanel), tests
BLOCKED_BY: — (renders 02's `source` field when present; degrades gracefully without it)

## Goal

The meta-plan calls the adoption counters "the real success metric" — today they render NOWHERE, and the friction ledger cannot be browsed in-UI. One new webapp view makes both visible. This is the UI-lied-"ready-to-land" lesson applied to the product loop: signals that render nowhere don't exist.

## Verified anchors (2026-07-17 recon)

- View registration is exactly three sites: `AppView` union + `coerceView` (`webapp/src/context/TaskContext.tsx:31`), the render switch (`webapp/src/App.tsx:97–128`), the nav array in `webapp/src/components/WorkbenchPane.tsx`.
- Templates to mimic: `OmpGraphPanel.tsx` (canonical self-fetch + poll + error/empty states via `apiJson`) and `CapabilityPanel.tsx` (verdict-header + count-chips + card-list layout).
- Data: `GET /api/adoption` (`server.ts:1018`, merged across managers; `summarizeAdoption` helper ready at `src/adoption-counters.ts:172`) and `GET /api/friction` (`server.ts:1926`, ring newest-first).
- No browse surface exists for either — this is cleanly additive; capture surfaces (composer grr popover, push-tap beacon) stay untouched.

## Approach

- ONE new view `daily` (one nav slot, not two): adoption counters as the header block (the three counter series — casual sessions/day, prompts/day, push taps/day — with a 7-day shape and today's values; `CapabilityPanel` layout idiom), friction ledger as the body (newest-first list, `OmpGraphPanel` fetch/poll idiom on `/api/friction`, ~20s).
- Friction rows: gripe, relative time, repo, context chip; `source:"auto"` rows visually distinct from human rows (02's field — when absent, render as human; never crash on old rows).
- Empty states are first-class: zero friction ("nothing filed — grr something") and zero counters (honest "no activity recorded", never fake zeros styled as data).
- Register in all three sites; verify the nav item is REACHABLE by clicking it in a real browser (comprehension-lane lesson: verify render sites, not just component existence).
- Taste bar: this is a user-facing surface — meta-plan standing requirement 2 applies (taste ≥ 7). Implementer loads the frontend-design-guidelines skill and follows `brand.md` (ember accent); the batch review includes a dedicated UX gate pass on this concern.

## Verify

- Unit: component renders with fixture data (counters + friction incl. sourceless legacy rows and auto rows); empty states; poll error state.
- Live (batch gauntlet): scratch daemon with seeded friction (one human via `glance grr`, one auto via 02's held-sync path if landed) + real counter data; drive the real webapp with agent-browser: click the nav item, see both signals, confirm auto/human distinction renders.
- UX gate: fable/opus reviews the rendered surface (screenshots) against frontend-design-guidelines — "feels instant and obvious" is an acceptance criterion.

## Scope boundary

Read-only surface — no new write routes, no notification-preferences UI (killed once, revisit on friction evidence), no webapp "start a here-session" affordance (deferred). No dashboard for land-assessment (different plan, different gate).
