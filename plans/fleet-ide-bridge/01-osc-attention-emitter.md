# OSC attention emitter — terminal-native attention lane

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/osc-notify.ts (new), src/tui.ts, the transition source that feeds sendPush in src/push.ts, tests/osc-notify.test.ts (new)
BLOCKED_BY: none

## Goal

When a unit transitions to a state that already fires web-push (needs-input / error / landed), the glance TUI/CLI ALSO writes terminal notification escape sequences to the controlling TTY — so WezTerm, Kitty, iTerm2, and the terax/cockpit notification bell surface fleet attention with no polling, no daemon round-trip, and zero dependencies.

## Approach

- New `src/osc-notify.ts`: `oscNotify(title: string, body: string)` writing to `process.stdout` ONLY when `process.stdout.isTTY` (never pollute pipes/logs). Emit BOTH established conventions, back to back:
  - `ESC ] 777 ; notify ; <title> ; <body> BEL` (urxvt convention; terax's detector self-arms on OSC 777 markers).
  - `ESC ] 9 ; <title>: <body> BEL` (iTerm2/WezTerm/ConEmu convention).
  - Sanitize `;`, control bytes, and cap payload length — a unit title must not be able to inject further escape sequences (terax hardened "terminal OSC trust" in their #319 for exactly this reason).
- Wire it into the SAME transition points that call `sendPush` (grep the `push.ts` call sites) so the lanes can never drift apart; extract a tiny `notifyAttention(payload)` fan-out if the call sites are already ≥2.
- TUI (`src/tui.ts`): additionally emit OSC 133 prompt markers (`133;A`/`133;B`) around interactive prompts so terminals with prompt-jump navigate glance sessions.
- Cockpit-compat note: before shipping, read terax's `src-tauri/src/modules/pty/agent_detect.rs` OSC 777 grammar (via `gh api`, read-only) and, if their marker payload differs from `777;notify`, emit their exact form as a third sequence behind the same call. Record the grammar found in this doc.
- Flag: `GLANCE_OSC_NOTIFY` env, default ON when TTY (it is inert when piped).

## Acceptance

- Unit test: transitions produce the exact byte sequences; non-TTY produces nothing; hostile title (`x;y\x1b]777;...`) is neutralized.
- Live: run the TUI in WezTerm or Windows Terminal, drive a unit to needs-input (scratch-daemon recipe), observe a native toast. Record which terminal was used in the PR body.
