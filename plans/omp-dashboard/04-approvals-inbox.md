# Approvals inbox + AnswerControls
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/inbox/*, webapp/src/components/agent/AnswerControls.tsx

## Goal
The HumanLayer core: a first-class **Inbox** view folding every `agent.pending[]` across the roster
(oldest-first) plus errored agents, each **answerable in place**, with jump-to-next — so the operator
clears blocked work from one screen.

## Approach
- **Fold** — derive `{agent, req}` rows from `agents.flatMap(a => a.pending.map(req => ...))`
  (`PendingRequest` `types.ts:30`), sorted by `req.createdAt` (oldest first); append `error` agents.
- **AnswerControls** (shared, also used by concern 05) — switch on `req.kind`:
  `confirm` → Approve / Deny; `input` → text field (+ `placeholder`); `select` → one button per
  `req.options`; `editor` → textarea prefilled with `placeholder`; host-tool kinds → Approve/Deny
  with `req.message` as the argument summary. Submit → `send({type:"answer", id:agent.id,
  requestId:req.id, value})` (mirror `index.html`'s `preq()`/`wireReq()`).
- **Flow** — after answering, focus the next unanswered row; empty → return to prior view. Sidebar
  **Inbox** badge = pending count. Re-fold live on `roster`/`agent` events so answered rows drop out.
- Each row shows agent name · repo · `req.title` so the operator has context without opening the agent.

## Cross-Repo Side Effects
None. `AnswerControls` is the shared seam concern 05 reuses inside the agent detail.

## Verify
- Spawn 2 agents `--approval always-ask` with tasks that trigger a tool approval → Inbox lists both
  oldest-first; answering each (confirm / select / text) removes its row live and decrements the badge.
- Drive one agent to `error` → it appears in the inbox's error section.
- `select`/`editor`/`input` kinds each render the right control and submit the right `value`.

## Resolution
AnswerControls (confirm/select/input/editor/host-tool) + InboxView folding pending oldest-first + errored agents, answering in place via the `answer` command. Fold logic extracted to lib/inbox.ts (tested). Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0; `cd webapp && bun run build` + `bun run test` 14/0; runtime smoke OK).
