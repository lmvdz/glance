# Epic H — Needs-you attention ladder (charter)

STATUS: executing (omp-squad half landed on t3face/06-daemon-ladder, pending cross-lineage review; glance-desktop cockpit consumer is concern 07, not yet started)
PRIORITY: p2
REPOS: omp-squad, glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: adoption gate (00-meta.md) — expands on friction-ledger evidence of attention pain, or a committed cockpit consumer
MODE: hitl

## Charter (expand into plans/daily-ladder/ when unblocked)

One server-computed priority state per unit — Pending Approval > Awaiting Input > land-blocked > Working > Completed-unseen > Idle — that every surface (webapp roster, cockpit panes, push, OSC lane) subscribes to; nothing computes its own ranking. Folds the four fragmented channels (AgentStatus, PendingRequest[], AttentionEvent[], AgentReport[] + land-blocked items) into `src/attention-ladder.ts`. Wave-0 push (`plans/daily-attention-w0/`) already covers the two rungs that buzz a phone; this epic is the full model.

## Locked constraints (from design review — binding at expansion)

- **File mode collapses to a single implicit viewer.** No per-viewer machinery where no principal exists (file mode = one bearer token, local surfaces resolve admin). Real viewerKeys only in DB mode where cookie identity exists; cap + TTL the lastVisited map either way.
- **Ladder state is a pure function of persisted state** (DTO + pending + attention + transitions); quiesce/transition events are invalidation hints only. Boot-time full recompute — the ladder must never be silently stale after a daemon restart.
- **Two-repo migration is staged additive.** Server ladder ships first; webapp and cockpit each delete their own client-side ranking in their own repo's PR; a version/capability flag on the WS payload lets the cockpit detect ladder presence. "Single atomic wave" across independently-released repos is a fiction — don't promise it.
- **Push-widening defaults are conservative** (fleet completion off, casual completion on; approval/input on everywhere).
- Fix the cockpit plan docs' SSE→WS transport error in the same pass (transport is WebSocket: SquadManager EventEmitter → server broadcast → ws.send).

## Execution ledger

**2026-07-17 — AUTHORIZED by Lars** ("Expand it — cockpit is the consumer"), executed as
plans/t3-face/06-daemon-needs-you-ladder.md on branch `t3face/06-daemon-ladder` (omp-squad only —
this pass never touches glance-desktop; that's concern 07).

Landed, pending cross-lineage review (codex + grok) before merge:

- `src/attention-ladder.ts` (new): the single pure `computeLadderPriority` cascade — `error` >
  `pending-approval` > `awaiting-input` > `working` > `plan-ready` > `completed-unseen` > `idle` —
  plus `maxLadderPriority` for roll-ups. `error` folds this charter's "land-blocked" rung in
  (a validator veto or a PR closed-without-merging both read as `error`, not a separate rung).
  `pending-approval` vs `awaiting-input` splits on the SAME `gateClass` flag `gateClassOf` already
  stamps on every `PendingRequest`.
- `src/attention.ts`: a new per-UNIT last-visited map (`unit-visited.json`, keyed by agent id, NOT
  the existing (repo,file) seen map) — `markUnitVisited`/`unitVisitedAt`, same durable/max-merge/
  fail-closed contract as the existing file-viewing seen map. **This is where the locked
  file-mode-collapse constraint lives**: `viewerId === undefined` (always true in file mode) reads/
  writes the single `lastSeenAt` slot; a real per-viewer id (DB mode only) gets its own entry.
- `src/types.ts`: `AgentDTO.ladderPriority` — COMPUTED, NOT PERSISTED (same idiom as
  `harnessScorecard`), so it can never go stale across a restart: `SquadManager.list()`/
  `getAgent()`/every `emitAgent` broadcast recompute it fresh, never only at a mutation site
  (boot-recompute rule, honored literally — there is no cached/stale path).
- `src/squad-manager.ts`: `syncLadder` (mirrors `syncAuthority`'s pattern exactly) stamps the
  VIEWER-AGNOSTIC hint value onto the shared roster DTO; `ladderPriorityFor(dto, viewerId)` is the
  ONLY place a real per-viewer `visitedAt` is threaded in — called by server.ts only, never
  mutates the shared object (the two-tier split this charter's "single state, per-viewer seen"
  constraint requires — see attention-ladder.ts's module doc for the full reasoning on why a
  shared mutable field can't carry per-viewer state without leaking between concurrent viewers).
  `lastCompletedAt` reads the durable `transitionLog` ring (survives a restart; `dto.receipt`/
  `dto.lastActivity` do not) for the last transition-into-idle as the completion timestamp.
- `src/server.ts`: `GET /api/agents` and `GET /api/agents/:id` now carry a personalized
  `ladderPriority` per unit (additive field, existing consumers unaffected). New
  `GET /api/attention/ladder` (per-unit + per-project + per-daemon roll-up) and
  `POST /api/attention/ladder/seen` (the mark-seen mutation, `{ agentId }`, viewerId/at always
  server-stamped). `src/authz.ts`: both new paths are viewer-tier, same reasoning as the existing
  `/api/attention` routes.
- Tests: `tests/attention-ladder.test.ts` (cascade order, fail-closed, roll-up) +
  `tests/attention.test.ts` (per-viewer seen-agreement, cross-viewer isolation, restart survival,
  kill-switch independence). `bun test` + `tsc --noEmit` both clean on the touched surface.

Deliberately NOT done here (out of scope for this pass): the cockpit UI consumer (glance-desktop
concern 07), the SSE→WS doc fix named above (that's a glance-desktop plan-doc correction, no
omp-squad file to touch), and any push-widening default change (push.ts is untouched — this pass
is read/roll-up/mark-seen only).
