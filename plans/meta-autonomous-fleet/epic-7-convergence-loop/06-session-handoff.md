# Session handoff at context-window pressure

STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
ISLEAF: false
NEEDS-DEEPER: no
TOUCHES: src/convergence-oracle.ts, scripts/converge.sh, src/convergence-run.ts, tests/convergence-handoff.test.ts

## RESOLUTION (shipped)

The unresolved design decision below is settled and built. The chosen relaunch mechanism is the
**outer `scripts/converge.sh` `while` loop** (candidate 1): each `claude -p "$(…--handoff)"` run is
ONE warm segment whose in-session Stop hook drives many `--once` iterations; when a segment ends
non-terminally (context pressure ended the session, not the goal), the loop relaunches a FRESH
session seeded by ONLY the handoff doc. The reconciliation the parent DESIGN flagged — warm WITHIN a
segment (Stop hook), cold ONLY at the seam (this loop) — is realized: the cold-restart cost is paid
once per segment, not per turn.

What shipped:
- `handoffDoc(state)` / `seedFromHandoff(doc)` on `src/convergence-oracle.ts` — the payload contract.
  The doc is a human-readable continuation prompt with an embedded JSON block, so it seeds a cold
  session for a human reader AND round-trips programmatically.
- `--handoff` / `--status` read-only flags on `src/convergence-run.ts` (over an exported
  `currentState()` that reads the persisted oracle, or a continuable seed if none exists yet) — the
  two gates the outer loop calls between segments: `--status` → terminality, `--handoff` → the seed.
- `scripts/converge.sh` — the outer loop. Read-only orchestrator: it shells out to `--status`
  (gate on terminality), `--handoff` (seed the next segment), and `claude -p` (the warm segment);
  `src/convergence-run.ts` owns all state writes.
- Watermark policy (item 2): the watermark is the harness's own context-window ceiling — a segment
  simply ends when the session can no longer continue; the outer loop then decides via the persisted
  oracle's `decision` whether to relaunch. No separate token counter is needed; the oracle IS the
  source of truth, and it persists across the cold seam (leaf 01 contract + the failures sidecar).
- Acceptance (item 4) is covered by `tests/convergence-handoff.test.ts`: a mid-progress oracle
  persisted by one segment is read back by a fresh `currentState()` (proving state survives the cold
  seam), the handoff doc round-trips that state, and a terminal oracle makes `--status` report the
  terminal decision so the loop stops relaunching. Sufficiency holds because Epics 1/3 read the
  oracle + on-disk artifacts, not session memory — a cold session resumes from the doc + disk alone.

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

Historical (pre-resolution): leaves 01-05 stood alone as a bounded single-session convergence loop
and were never blocked on this branch. This branch is now resolved and shipped in place (no separate
sub-plan directory was needed once the mechanism was chosen — see RESOLUTION).

## Verify

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
bun run check
bun test tests/convergence-handoff.test.ts        # round-trip + cold-seam continuity + terminality gate

# Live: --status/--handoff over an isolated state dir with a persisted mid-progress oracle
SD=$(mktemp -d); mkdir -p "$SD/convergence"
printf '{"goalId":"plans/demo","iteration":5,"gap":3,"epsilon":0,"pendingEscalation":false,"budget":{"spent":5,"cap":50},"decision":"continue","updatedAt":0}' > "$SD/convergence/oracle.json"
OMP_SQUAD_STATE_DIR="$SD" bun src/convergence-run.ts --goal plans/demo --status   # → continue
OMP_SQUAD_STATE_DIR="$SD" bun src/convergence-run.ts --goal plans/demo --handoff  # → seed doc carrying iteration 5, gap 3
```
