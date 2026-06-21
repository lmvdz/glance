# Research brief — make the omp-squad UI/UX better to see & interact with

**Goal**: improve the two human-facing surfaces (web dashboard, terminal TUI) so an operator
can *see* fleet state at a glance and *step in* the moment an agent needs them.
Intelligence only — no production code here.

**Scope of surfaces**
- `src/web/index.html` — single-file vanilla-JS SPA (~1000 lines, no build, no deps). WebSocket
  client of `SquadEvent`.
- `src/tui.ts` — pi-tui terminal dashboard. Pure `buildBoard()` renderer + mounted `Editor`.
- `src/server.ts` — HTTP/WS bridge. Broadcasts `SquadEvent`s; the roster payload already carries
  everything the high-value UX wins need.

---

## 1. Current state (grounded)

**Web** already has: dark theme + CSS-var palette; projects sidebar; agent-card grid (status
badge, kind glyph, activity, todo, ctx%); breadcrumb; agent view with a hand-rolled
CommonMark renderer + dependency-free syntax highlighter; Changes (git diff) panel; Subagents
tree; inline pending-input controls (`preq()`); a feature **kanban board**; Plane issues;
presence + file-lease panels; slash-command fuzzy completion (`attachCompletion`); toasts; hash
routing; `localStorage` for a couple of toggles.

**TUI** has: two-level arrow nav (list → agent), status dots + kind glyphs, transcript scroll,
inline pending hints, a real `Editor` composer with history/paste/kill-ring.

**Data already on the wire** (`AgentDTO`, `src/types.ts:139`): `status`, `kind`, `activity`,
`todo`, `contextPct`, `pending[]`, **`lastActivity`**, `error`, `issue`, `parentId`. Server
broadcasts full roster + per-agent `agent` events (`src/server.ts:53`). **No server change is
needed for the top wins.**

**Confirmed absent** (searched): Web Notification API, `document.title`/favicon badging,
command palette, global keyboard nav, any global "needs-input" view. Header shows a *text*
count (`X need input`, `index.html:320`) that is not clickable.

---

## 2. Prior art scouted (patterns, not products)

| Source | Transferable pattern |
|---|---|
| **Vibe Kanban** (the "doomscrolling gap": the 2–5 min an agent works and you have nothing to do) | Async fleets need a **pull signal** — notify when work *finishes or blocks*, don't make the human poll. |
| **Conductor** (worktree-per-agent, diff-first review) | Validates omp-squad's model; review-before-merge is the loop. **Changes/Land** already cover this. |
| **Hermes HUD** (TUI: tmux operator view, jump hints, **operator queue for approvals + errors**, Ctrl+P palette) | A single **operator queue** aggregating every approval/error across agents, plus a **command palette**. |
| **Kiro CLI** (Ctrl+G monitor subagents, Ctrl+D/U to move between sessions) | Dedicated keyboard verbs to *cycle blocked/active sessions*. |
| **Command-palette UX canon** (Superhuman, cmdk, Maggie Appleton) | One ⌘K fuzzy launcher for destinations **and** actions when a product has many of both; toggle on the same key; restore prior focus. |
| **TUI-design canon** (rothgar/awesome-tuis, tui-design) | Keyboard-first (j/k), animations never delay input, 15–30fps, semantic color hierarchy, braille spinners for "thinking", progressive disclosure in a footer. |
| **Orchestrator model** (Addy Osmani: pair-programming → managing a team) | The mental model is **supervise-by-exception**; the UI's job is to route attention, not to be watched continuously. |

Recurring cross-source signal: **the bottleneck of N parallel agents is the operator's
attention, not the agents.** Every strong tool optimizes "what needs me, right now."

---

## 3. Comparator — concept vs. our gap

| Concept | How prior art does it | Transferable? | Our gap |
|---|---|---|---|
| Attention inbox | Hermes operator queue; header→actionable | Yes | Blocked agents are buried per-project; count is non-clickable text |
| Push signals | Vibe Kanban notify on done/block | Yes | No notification/title/sound; pure poll |
| Command palette | ⌘K fuzzy over nav+actions | Yes | None; only slash-completion inside a composer |
| Keyboard parity | Kiro session cycling; vim nav | Yes | TUI is keyboard-first; **web is mouse-only** |
| Liveness/staleness | spinners; "thinking" indicators | Yes | Static dots; `lastActivity` unused in cards → silent hangs invisible |
| Context-pressure cue | semantic color ramp | Yes | ctx% is plain text, no urgency near 100% |
| Styled, cancelable dialogs | in-app modals | Yes | `prompt()`/`confirm()` for new/auto-feature & kill (`index.html:464,486,768,986`) |
| Surface parity | one core, many thin clients | Partial | README claims it; TUI lacks projects/board/queue/stall the web has |

---

## 4. Abstracted concepts to drive the plan (ranked)

**A. Attention queue — supervise-by-exception inbox** *(highest impact)*
Pattern: aggregate every `pending` request across the whole roster into one always-reachable,
inline-answerable surface, with "jump to next blocked."
Mechanism: client-side fold over `agents.values()` → `pending[]`; reuse `preq()` + the `answer`
command. Make the header count (`index.html:320`) the entry point.
Applies: web (new global view + header), `src/tui.ts:buildBoard` (a "⛔ N waiting — press a to
answer" row + verb). No server change.
Build vs buy: **build** — trivial fold over data already present.

**B. Push signals — close the doomscrolling gap** *(highest impact)*
Pattern: turn state *transitions* into out-of-band pulls so the human can look away.
Mechanism: diff incoming `agent` events against prior status (web `handle()` `index.html:275`,
TUI `handleEvent` `tui.ts:300`); on →`input`/→`error`/→`idle(done)` fire: Web Notification API
(rung-3 native), `document.title` + favicon badge (count of waiting), optional short sound; TUI
terminal bell `\x07` / OSC 9 desktop notify. User-gated (permission + a mute toggle).
Applies: web `handle`, header; `src/tui.ts` event sink.
Build vs buy: **build on native platform APIs** — no dependency.

**C. Command palette + web keyboard parity**
Pattern: one ⌘K/Ctrl-K fuzzy launcher over destinations (projects, agents, features, board)
**and** actions (spawn, land, kill, interrupt, upgrade, jump-to-next-blocked); plus j/k/Enter/Esc
roster nav mirroring the TUI's two-level model into the browser.
Mechanism: **reuse the existing fuzzy filter+sort already in `attachCompletion`**
(`index.html:245`); a flat command registry; the same key toggles open/closed and restores focus.
Applies: web (global key handler + overlay; CSS `.cmpl` styling is reusable scaffolding).
Build vs buy: **build** — matcher already exists in-repo.

**D. Glanceable liveness & staleness**
Pattern: show *is it actually progressing?*, not just *what status flag*.
Mechanism: animated spinner on `working` (TUI already defines `spinnerFrames`, `tui.ts:187`;
unused in board); derive a **stall badge** ("idle Nm") when `working` but `now-lastActivity` >
threshold; ramp `contextPct` color (calm→warn→danger) approaching compaction.
Applies: web `fillAgentGrid` (`index.html:600`), `dots`; TUI row (`tui.ts:129-140`).
Build vs buy: **build** — `lastActivity` is already in the DTO.

**E. Consistent in-app dialogs over native `prompt`/`confirm`**
Pattern: styled, cancelable `<dialog>` instead of blocking browser primitives.
Mechanism: one small prompt-modal helper; the `<dialog>`/`.modal` pattern already exists
(`index.html:176`). Trust boundary unchanged (same actions, same confirm intent) — better
affordance + escape.
Applies: web `newFeature`/`newAutoFeature`/kill/upgrade.
Build vs buy: **build** — reuse existing modal CSS.

**F. Surface-parity discipline (cross-cutting constraint, not a feature)**
Keep every new derivation (waiting-count, stall heuristic) in the shared core/`AgentDTO` shape
so **both** web and TUI consume one source of truth — honoring the codebase's "one seam, thin
clients" design (README; `AgentDriver`). Bring A, B, D to the TUI too, so it stops lagging the web.

*(All build-over-buy and platform-native-first — consistent with the repo's ponytail mandate in
AGENTS.md. No new dependency is warranted: vanilla SPA, pi-tui, Notification API, terminal bell.)*

---

## 5. The abstracted concepts that should drive the plan

1. **Route attention, don't demand it** — a single fleet-wide *attention queue* of everything
   blocked/errored, answerable in place, with jump-to-next. (A)
2. **Async work needs a pull signal** — convert status *transitions* into native notifications +
   title/favicon/bell badges so the operator can supervise by exception. (B)
3. **One keystroke to anywhere/anything** — a ⌘K command palette (reusing the existing fuzzy
   matcher) plus full keyboard navigation, giving the web the TUI's keyboard-first parity. (C)
4. **Show liveness, not just status** — spinners, a staleness/stall heuristic from `lastActivity`,
   and context-pressure color, so silent hangs and near-compaction agents are visible at a glance. (D)
5. **Consistent, cancelable in-app interaction** — replace native `prompt`/`confirm` with the
   styled modal pattern already in the file. (E)
6. **One core, two thin clients** — derive new signals once in the shared shape; ship them to both
   web and TUI so the surfaces stay in sync. (F)

**Build-vs-buy verdict: borrow every pattern, add zero dependencies.** The two biggest wins
(attention queue, push signals) are client-only — the data is already broadcast.
