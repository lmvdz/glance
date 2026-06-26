# TUI parity — attention, push, liveness
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/tui.ts, tests/squad.test.ts
BLOCKED_BY: —
VERIFY_BLOCKER: —
PLANE: OMPSQ-5 — https://app.plane.so/inkwell-finance/browse/OMPSQ-5/

## Goal
Bring the three highest-value attention features to the terminal surface so it stops lagging the
web (BRIEF §F: one core, two thin clients). Add to the TUI: (A) a fleet-wide "waiting" indicator
+ a jump-to-next-blocked verb, (B) a terminal bell / OSC desktop notify on `→input`/`→error`, and
(D) a working spinner + stall badge in the board. Runs fully parallel to the web track (different
file).

## Approach
1. **Waiting indicator + jump verb (A).** `buildBoard` (`src/tui.ts:111-173`) already computes
   `need` (`:114`) and prints it in the title. In list view add a one-line hint when `need>0`:
   "⛔ N waiting · press a to answer the oldest". Add an `a` key in `handleKey` (`:406-414`) that
   selects the oldest `status==="input"` agent (min `lastActivity`) and `openSelected()`s it so its
   pending hint + composer are ready (the answer path already exists, `submit` `:380-386`). After
   answering, `a` again jumps to the next blocked agent.
2. **Push signal (B).** In `handleEvent` (`:294-326`), on the `agent` case compute the prior
   status before replacing `this.state.agents[i]` and, on `* → input` or `* → error`, emit a
   terminal bell (`process.stdout.write("\x07")`) and optionally an OSC 9 notification
   (`\x1b]9;<text>\x07`) — both native escape sequences, no dependency. Guard the initial `roster`
   so a reconnect/replay doesn't ring repeatedly; throttle per agent.
3. **Spinner + stall (D).** In the list row (`:129-140`) the dot is static and `spinnerFrames`
   (`:187`) is defined but unused on the board. For `working` agents render a spinner frame driven
   by the existing `redrawTimer`/`scheduleRedraw` cadence (advance a frame counter on redraw). Add
   a stall marker when `status==="working" && Date.now() - a.lastActivity > STALL_MS` (keep
   STALL_MS identical to concern 04). Surface it in the `act`/`meta` column.
4. Keep `buildBoard` pure (state in → lines out); pass `now` + `frame` via `BoardState` so the
   renderer stays deterministic and testable (extend `BoardState`, `:55-68`).

ponytail: terminal bell + OSC are native; the spinner frames and redraw timer already exist. The
only new state is a frame counter + a `now` field — both injected so the pure renderer stays
unit-testable.

## Cross-Repo Side Effects
`BoardState` gains `now` and `frame` (and STALL_MS is shared with concern 04 by value, documented in
both — no import across HTML/TS). Any existing `buildBoard` test must pass the new fields.

## Verify
- `bun run check` — types clean.
- `bun test tests/tui.test.ts` — extend/add assert cases on the **pure** `buildBoard`:
  - `need>0` → title shows "N need input" and list shows the "press a to answer" hint.
  - a `working` agent with `now - lastActivity > STALL_MS` → row contains the stall marker; a recent
    one does not.
  - `frame` advances the spinner glyph for a `working` agent.
- Manual: `omp-squad up`; spawn an `always-ask` agent; trigger an approval → terminal bell rings,
  `a` jumps to it; while it works the row spins; pause it past STALL_MS → stall marker appears.

## Resolution

Closed 2026-06-21 via OMPSQ-5 (https://app.plane.so/inkwell-finance/browse/OMPSQ-5/).
`BoardState` gained injected `now`+`frame` so `buildBoard` stays pure; the list view now renders a
braille spinner on `working` rows, a "⏳" stall marker past STALL_MS (=120000, matches OMPSQ-7),
and a "⛔ N waiting · press a to answer" hint. `handleEvent` rings a terminal bell + OSC 9 notify
on →input/→error (seeded + per-agent 2s throttle so reconnects don't storm); `a` (empty composer)
jumps to the oldest blocked agent; a `maybeAnimate` timer advances the spinner only while agents
work. Tests live in `tests/squad.test.ts` (where the existing pure-`buildBoard` cases already are),
not a new `tui.test.ts` — reusing the `board()` fixture rather than forking it. Gate: `bun run
check` clean, 130 tests pass (+3 new).
