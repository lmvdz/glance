# C05 — roster + attention panes

STATUS: done (glance-desktop#11, merged)
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: C04

## Reality notes (2026-07-14, glance-desktop#11)

Transport reality differs from the concern's SSE assumption: the daemon pushes over a **WebSocket at /ws**, and the fork CSP `connect-src` allows `http://127.0.0.1:*` but NOT `ws://`. So C05 POLLS `GET /api/agents` (2s) behind one swappable store method — a push upgrade (widen CSP for ws, or a daemon SSE endpoint) is a deliberate follow-up, not smuggled into a roster PR. `rankUnit` mirrors the daemon TUI `agentRank` exactly (verified against src/tui.ts). Poll-failure keeps last-good roster + shows "reconnecting"; recovers to "live". Gate: tsc/lint(103)/vitest 364/build green; /api/agents array contract verified live (empty case) + field mapping source-verified. GUI populated-render not driven (noted). No cross-lineage gauntlet (read-only poller+UI).

**Follow-up filed here**: push transport for the roster — either widen the fork CSP `connect-src` to `ws://127.0.0.1:* ws://localhost:*` and reuse the daemon's `/ws` socket, OR add a daemon-side SSE endpoint (cleaner — no CSP widening). Security-surface decision (connect-src is the exfil control), so deliberate, not default.
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
