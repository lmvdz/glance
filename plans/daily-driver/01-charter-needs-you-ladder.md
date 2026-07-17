# Epic H — Needs-you attention ladder (charter)

STATUS: blocked
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
