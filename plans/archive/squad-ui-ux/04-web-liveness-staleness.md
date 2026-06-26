# Web liveness & staleness cues
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 03 (shared file src/web/index.html only — no logical dependency)
VERIFY_BLOCKER: `git log --oneline -1 -- src/web/index.html` shows concern 03 landed
TOUCHES: src/web/index.html
PLANE: OMPSQ-7 — https://app.plane.so/inkwell-finance/browse/OMPSQ-7/

## Goal
Show *is it actually progressing?*, not just *what status flag* — so silent hangs and
near-compaction agents are visible at a glance (BRIEF §D). Today cards show static dots; the
`lastActivity` field (`AgentDTO`, `src/types.ts:165`) is unused in the web cards, and `contextPct`
renders as plain text with no urgency.

## Approach
1. **Working spinner.** In `fillAgentGrid` (`index.html:600-620`) and the agent header
   (`agentHeaderHTML`, `:710`), render an animated braille/dot spinner next to the badge when
   `a.status==="working"`. Drive it with a single shared `setInterval` (~120ms) that advances a
   global frame index and updates only the visible spinner spans (one timer, not one per card).
   Stop the timer when no agent is `working`.
2. **Stall heuristic (the one pure check).** `isStalled(a, now)` = `a.status==="working" &&
   now - a.lastActivity > STALL_MS` (STALL_MS ≈ 120000; name the constant). When stalled, render a
   "⏳ Nm idle" badge on the card and color it `--work`. This is the load-bearing logic →
   extract as a small standalone function so it is unit-checkable (see Verify).
3. **Context-pressure ramp.** Replace the plain `ctx X%` text (`:616`) with a color-ramped pill:
   calm (`--dim`) < 70%, `--work` 70–90%, `--input`/`--err` > 90%, with a tooltip "approaching
   compaction". Apply the same ramp in the agent header.
4. **Relative-time read-out.** Show `lastActivity` as a compact "Ns/Nm/Nh ago" on each card
   (reuse the formatting already in `loadPresence`, `:661-662` — extract `ago(ms)` and share it).
   Refresh these on the same shared timer so they tick without a server event.
5. **TUI parity note:** the same spinner + stall live in concern 06 for `buildBoard`; keep the
   thresholds identical (document STALL_MS in both).

ponytail: one shared timer, derived entirely from `lastActivity`/`status`/`contextPct` already on
the wire. No new data, no dependency. Extract `isStalled` + `ago` as tiny pure helpers (reused, and
the only non-trivial logic).

## Cross-Repo Side Effects
None — client-only.

## Verify
- Add an inline assert block (or a `tests/`-side node check if a helper is exported): `isStalled`
  returns false for `idle`/recent `working`, true for `working` with `lastActivity` older than
  STALL_MS; `ago()` formats 5s→"5s", 120s→"2m", 7200s→"2h". Smallest assert that fails if the
  branch breaks.
- `omp-squad up --no-tui`; spawn an agent → its card shows a moving spinner while working and
  ctx% colored by band; the "ago" read-out ticks up between server events.
- Force a stall (a long-running tool, or pause the child) → after STALL_MS the "⏳ idle" badge
  appears; resuming clears it.

## Resolution

Closed 2026-06-21 via OMPSQ-7 (https://app.plane.so/inkwell-finance/browse/OMPSQ-7/).
Added pure helpers `ago()`, `isStalled()` (STALL_MS=120000, shared by value with OMPSQ-5) and a
ctx color ramp; a single shared 120ms timer advances braille spinners on `working` cards/header
and ticks `.agotime` read-outs in place (no re-render). Cards + agent header now show the spinner,
a "⏳ idle Nm" stall badge, colored ctx%, and relative time; `loadPresence` refactored to reuse
`ago()`. Gate green; `node --check` OK. Note: no isolated unit test — the helpers live in the
no-build inline module; extracting a module solely to assert them would breach the AGENTS.md
ponytail ladder, so they are verified by review + the regression gate.
