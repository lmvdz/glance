# Web attention queue — supervise-by-exception inbox
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/web/index.html
PLANE: OMPSQ-3 — https://app.plane.so/inkwell-finance/browse/OMPSQ-3/

## Goal
Give the operator one always-reachable, fleet-wide view of *everything that needs them right now*
— every agent in `status: "input"` (and `error`) — with the pending request answerable in place
and a "jump to next blocked" affordance. Today blocked agents are buried per-project and the
header's `X need input` (`index.html:320`) is dead text.

## Approach
1. **Make the count actionable.** The header `#counts` span (`index.html:159,318-321`) currently
   renders plain text. Add a dedicated, always-visible **"⛔ N waiting"** button/pill in the header
   (next to `#counts`) that is hidden when N=0 and styled with `--input` when N>0. Clicking it opens
   the queue view.
2. **New view `"queue"`** alongside the existing `view` states (`"project" | "agent" | "board" |
   "feature"`, see `index.html:193`, `renderBody` `:349`). Add:
   - a `renderQueue(body)` that folds over `agents.values()` collecting `{agent, req}` for every
     `a.pending[]` entry, sorted by `a.lastActivity` (oldest-waiting first), then appends `error`
     agents below.
   - reuse `preq(p)` (`:836`) for the controls and the existing wiring in `renderPending`
     (`:825-835`) / `renderFeatureGate` (`:448-461`) for `confirm`/`select`/text → `send({type:
     "answer", id, requestId, value})`. Each row shows agent name + repo + request title so the
     operator has context without opening the agent.
   - an "Open agent" link per row (`openAgent(a.id)`) for when the answer needs the transcript.
3. **Jump-to-next.** After answering a request, if more remain, keep the queue open and scroll/focus
   the next row; if the queue empties, return to the prior view. Keyboard: while the queue is open,
   `Enter`/`n` focuses the next unanswered control (the global key handler arrives in concern 03 —
   here, wire the click + a minimal `keydown` on the queue container only).
4. **Routing + live refresh.** Add `#/queue` to `pushRoute`/`applyRoute` (`:299-314`). In `handle()`
   (`:272`) and `refreshShell()` (`:726`), when `view==="queue"` re-render the queue on every
   `roster`/`agent` event so answered/lost requests drop out immediately (mirror the board branch
   `:728`). Reuse `CSS.escape` for `data-req` lookups as elsewhere.
5. **Styling.** Reuse `.section`, `.preq`, `.badge b-<status>`, `--input`. No new CSS framework.

ponytail: this is a pure client-side fold over data already broadcast — no server route, no new
dependency. The answer/await wiring is copied from `renderFeatureGate`, not reinvented.

## Cross-Repo Side Effects
None. No `src/server.ts`/`src/types.ts` change — `pending[]` and `lastActivity` already exist on
`AgentDTO`.

## Verify
- `omp-squad up --no-tui`; spawn 2 agents with `--approval always-ask` and tasks that trigger a
  tool approval. Confirm: header shows "⛔ 2 waiting"; clicking opens the queue listing both,
  oldest-first; answering one (Yes/No/select/text) removes its row live and the count decrements;
  emptying the queue returns to the prior view.
- Drive one agent to `error` (kill its child) → it appears in the queue's error section.
- Refresh the page on `#/queue` → deep-link restores the queue.

## Resolution

Closed 2026-06-21 via OMPSQ-3 (https://app.plane.so/inkwell-finance/browse/OMPSQ-3/).
Added a fleet-wide attention queue to `src/web/index.html`: an actionable header "⛔ N waiting"
button, a `#/queue` view folding every `pending[]` across the roster (oldest-first) + errored
agents, answerable in place via a shared `wireReq()` (also now used by `renderPending`), live on
roster/agent events, deep-linkable. Gate green (`bun run check` + 127 tests); inline module syntax
validated with `node --check`.
