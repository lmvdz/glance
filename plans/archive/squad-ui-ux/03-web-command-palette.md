# Web command palette + keyboard navigation
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 02 (shared file src/web/index.html only — no logical dependency)
VERIFY_BLOCKER: `git log --oneline -1 -- src/web/index.html` shows concern 02 landed
TOUCHES: src/web/index.html
PLANE: OMPSQ-6 — https://app.plane.so/inkwell-finance/browse/OMPSQ-6/

## Goal
One ⌘K / Ctrl-K fuzzy launcher over destinations (projects, agents, features, board, queue) **and**
actions (spawn, jump-to-next-blocked, land, interrupt, restart, kill, upgrade), plus j/k/Enter/Esc
roster navigation so the browser reaches the TUI's keyboard-first parity (BRIEF §C). Today the web
is mouse-only; the only fuzzy UI is the in-composer slash menu.

## Approach
1. **Reuse the matcher.** `attachCompletion` (`index.html:217-270`) already has the fuzzy
   `filter`+`startsWith`-priority `sort` (`:245-247`) and an overlay (`.cmpl` CSS, `:141-150`).
   Extract that filter/sort into a small `fuzzyRank(items, query, key)` and reuse it for both the
   slash menu and the palette — do not fork the logic.
2. **Command registry.** A function `paletteItems()` returning a flat list built live from state:
   - destinations: each project (`projects()`), each agent (`agents.values()` → "Open <name>"),
     "Feature board", "Attention queue", "Home".
   - global actions: "Spawn agent…", "Answer next blocked", "Upgrade daemon".
   - context actions when `view==="agent"`: "Land", "Interrupt", "Restart", "Kill" for `selAgent`.
   Each item = `{ label, hint?, run() }`. Reuse the `.cmpl .ci` row markup.
3. **Overlay + key toggle.** A `<dialog>` or a positioned `.cmpl`-style panel centered on screen.
   A global `keydown` listener: `(e.metaKey||e.ctrlKey) && e.key==="k"` toggles it (open *and*
   close on the same key — Superhuman/cmdk rule), Esc closes, restoring `document.activeElement`
   captured at open. Arrow/Enter handled by the same `handleKey` shape `attachCompletion` returns.
   Do not steal keys while focus is in a textarea/input except the ⌘K combo itself.
4. **Roster keyboard nav (TUI parity).** When not typing in a field and the palette is closed:
   `j`/`↓` and `k`/`↑` move a selection highlight through the visible agent cards
   (`fillAgentGrid`, `:600`); `Enter`/`→` opens the selected agent; `Esc`/`←` backs out
   (agent→project→home), mirroring the TUI two-level model (`tui.ts:onLeft/onRight`). A `g` then
   `b`/`q` shortcut pair (board/queue) is optional polish, not required.
5. **Discoverability.** A subtle "⌘K" hint in the header.

ponytail: the fuzzy engine and overlay CSS already exist — this concern is wiring a registry and a
key router on top, no new dependency. Keep `fuzzyRank` the single matcher for both menus.

## Cross-Repo Side Effects
None — client-only. (Slash-menu behavior must remain unchanged after the `fuzzyRank` extraction —
regression-check it.)

## Verify
- Press ⌘K (and Ctrl-K) anywhere → palette opens; type part of an agent/project name → fuzzy
  filtered, top match selectable with ↑/↓ + Enter; press ⌘K again or Esc → closes and focus
  returns to where it was.
- Run "Answer next blocked" with a blocked agent present → lands on the queue/first request.
- From an agent view, run "Land"/"Kill" via the palette → same effect as the buttons.
- On the project view, j/k moves the card highlight, Enter opens it, Esc backs out.
- Type `/` in the composer → the slash menu still works exactly as before (no regression from the
  matcher extraction).

## Resolution

Closed 2026-06-21 via OMPSQ-6 (https://app.plane.so/inkwell-finance/browse/OMPSQ-6/).
Extracted a shared `fuzzyRank()` and routed BOTH the composer slash menu and a new ⌘K/Ctrl-K
command palette through it (no fork). Palette is a live `paletteItems()` registry over
destinations (home/queue/board/projects/agents) + actions (new agent, answer-next-blocked,
upgrade, and agent-context land/interrupt/restart/kill via the existing buttons), toggles on the
same key, restores prior focus on close. Added j/k/↑/↓ card highlight + Enter/→ open + Esc/← back
(skipped while focus is in a field). Gate green; `node --check` OK; slash menu unchanged.
