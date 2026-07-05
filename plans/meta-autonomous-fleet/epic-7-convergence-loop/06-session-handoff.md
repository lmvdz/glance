# Session handoff at context-window pressure

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
ISLEAF: false
NEEDS-DEEPER: yes
TOUCHES: src/convergence-oracle.ts, scripts/continue-loop.sh, src/convergence-run.ts

## Why this is a branch, not a leaf

The warm-loop premise (leaves 01-05) keeps ONE session alive so the prompt cache stays warm. But a
single session eventually hits the context-window ceiling and cannot continue. The DESIGN calls for
"long warm sessions chained by a clean handoff seeded with the verified-state doc" — and that
carries a genuine **unresolved design decision** that leaves 01-05 deliberately do not settle:

- Spawning a fresh session is inherently cache-**cold**, directly contradicting the reason the Stop
  hook exists. *When* is the cold-restart cost worth paying vs. just stopping and escalating? (A
  turn/token watermark? A hard iteration count? Validator-signalled diminishing returns?)
- *How* does the chain actually re-launch in the harness? Candidate mechanisms, each with real
  tradeoffs to evaluate against the live Claude Code harness:
  - an **outer `scripts/converge.sh` `while` loop** that runs `claude -p "$(handoffDoc)"`
    repeatedly, treating each in-session Stop-hook loop as one warm *segment* — this makes the
    Stop hook and an outer cron-like loop coexist, which the parent DESIGN explicitly set the Stop
    hook up to AVOID; the reconciliation (warm within a segment, cold only at the seam) needs
    designing.
  - a **hook-initiated relaunch** where `continue-loop.sh`, on crossing the watermark, writes the
    handoff doc and emits a terminating instruction rather than a `block` — but a Stop hook cannot
    cleanly spawn a replacement interactive session; the operator or a supervisor must.
  - **operator-mediated**: the loop stops with a "resume me" proposal (the report primitive from
    Epic 5) carrying the compact verified-state doc; a human (or the supervisor) re-invokes.
- The handoff payload itself (`handoffDoc()` on `src/convergence-oracle.ts`) is the easy part — a
  compact serialization of `VerifiedState` + the frontier — but its *sufficiency* (can a cold
  session resume with only this doc and no prior transcript?) depends on how much Epics 1/3 make
  the planner/validator stateless vs. session-coupled, which is not yet known.

## Seed for the deeper sub-plan (do NOT implement blind)

1. `handoffDoc(state, frontier): string` serializer on `src/convergence-oracle.ts` + its inverse
   `seedFromHandoff` — the payload contract (leaf-sized once the mechanism is chosen).
2. Watermark policy: where the turn/token budget threshold lives and how it is measured (the Stop
   hook sees `stop_hook_active` but not token counts — decide the source of truth).
3. The chosen relaunch mechanism (outer-loop vs operator-mediated) wired into `convergence-run.ts`
   / a new `scripts/converge.sh`.
4. Acceptance: force a low watermark, confirm segment 1 stops with a handoff doc and segment 2
   resumes from ONLY that doc to the same terminal `decision`, with no verified-gain lost across
   the seam (the ratchet still holds across segments).

## Scope boundary

Nothing ships from this file until it is decomposed into its own sub-plan. Leaves 01-05 stand
alone as a bounded single-session convergence loop; do not block them on this. When decomposed,
this becomes `plans/meta-autonomous-fleet/epic-7-convergence-loop/06-session-handoff/` (or folds
into a revised Epic 7 once the harness relaunch mechanism is settled).

## Verify

N/A until decomposed — this is a flagged branch, not a runnable leaf.
