# Design: Change-driven, auditable background loops

Borrow 3–4 patterns from the prose.md / Reactor research (reconciliation, causal
receipts, plan-DAG validation) to make omp-squad's background loops re-run only
when their inputs actually change, make "idle vs stuck" observable, and catch
malformed plan graphs before they're acted on. Borrow the patterns; adopt no
external dependency.

## Approach

The adversarial design pass (designer → 2 red teams → arbiter) collapsed an
ambitious draft (new modules, two mutable state files, a new endpoint, LLM-inferred
scope contracts) down to the parts that pay for themselves. Net footprint:
**~70–90 LOC, zero new modules, zero new state files, zero new endpoints, zero new
LLM calls.**

Ship order — **#2 → #1 → #4** (#2 first because #1's skip events ride on the
`skipReason` field #2 adds):

- **#1 Change-driven gate** — the only genuinely costly per-tick work is the
  Observer re-running the repo's full acceptance suite (`bun test`/`tsc`) every 60s,
  unconditionally. Gate it on a cheap fingerprint of the inputs it actually reads,
  computed inside the existing land-lock. Reuses the in-repo idiom (`agentHasUnlandedWork`)
  rather than inventing a cursor subsystem.
- **#2 Causal receipts** — a skipped run still emits a heartbeat that says *why* it
  did nothing, and the dashboard learns to tell a healthy-idle loop from a wedged
  one. Rides the existing append-only automation log; no new file.
- **#4 Plan-DAG validation** — one validator next to the existing graph builder
  surfaces cycles and dangling dependencies (today both are silently swallowed) as
  non-blocking warnings.
- **#3 Agent-scope contracts (`requires`/`produces`)** — **cut from v1** (see Open
  Questions); the honest version is a standalone follow-up, not a rider here.

## System boundary

| In scope | Out of scope |
|----------|--------------|
| Observer acceptance-gate gating (the costly call) | Re-architecting the loop DI in `squad-manager` |
| One new optional field on the automation event | Orchestrator/Dispatch gating (already change-gate per-agent) |
| Dashboard idle-vs-stuck classification | A new persisted cursor/skip state file |
| Plan-DAG cycle + unresolved-dep warnings | Hard-gating the plan pipeline on validation |
| — | Agent `requires`/`produces` contracts (deferred) |

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|----------|--------|-------------------------|-----------|
| Gate fingerprint inputs | Working-tree content hash (porcelain status + lockfile bytes) | `git rev-parse HEAD`; HEAD + branch SHAs | The gate runs against the live working tree (`cwd: repo`), so HEAD is blind to dirty/uncommitted/install state — confirmed in code. Fingerprinting on HEAD would skip a red gate and report healthy. |
| Where the gate fingerprint lives | Private in-memory field on the manager, keyed by repo | New `loop-cursor.ts` module + `loop-cursors.json` | Exactly one costly check exists — a module/file is speculative. A torn shared JSON would silently disable the gate. Restart re-running the gate once is the correct fresh baseline. |
| When the fingerprint is computed | Inside the existing land-lock | At tick start, lock-free | A land's mid-merge state must never be sampled as a half-written fingerprint — that's the exact false-regression race the lock already prevents. |
| Safety against a missed input | Force-run every Nth tick (N≈10) regardless of fingerprint | Trust the hash absolutely | Bounds staleness if the hash ever misses a dimension (e.g. a toolchain/PATH change). The maintainer's own code comment already prescribes an Nth-tick throttle. |
| Skip observability | One `skipReason?` field on the automation event; emit a skip as a normal low-cost event | New `loop-skips.json` + new `/api/automation/skips` | The automation log is already append-only, hydrated-on-restart, crash-tolerant. A skip *is* an automation event. |
| Idle vs stuck | Derive from the rollup's existing `lastAt` vs `now` | A separate stuck-detector state file | The rollup already carries `lastAt` and takes `now`; this is a display threshold, not new state. |
| Skip/event keying | `loop` for fleet-wide loops, `loop:repo` for per-repo loops | `loop`-only | Per-repo loops run N instances; a `loop`-only key lets one repo's record clobber another's (lost update). |
| Plan-DAG validator | One implementation next to the existing graph builder, fed the same edge map | A separate DFS duplicated into 3 skills | A separate parser validates a *different* graph than the one rendered; triple-copies drift. |
| Validator checks | Cycles + unresolved deps only | + orphan detection | Orphans are normal batch-0 roots → mostly false positives. |
| Validator severity | Warning-first, non-blocking | Hard-gate the pipeline | Don't wedge the pipeline on a v1 heuristic; promote to a gate later if it earns trust. |
| Pattern #3 | Cut from v1, defer the honest win to a standalone plan | Ship as drafted | It doesn't feed dispatch ordering (which keys on issue-id blockers only) and is checked against an LLM-inferred, frequently-empty `owns` — near-zero enforcement on the autonomous path. |

## Risks

| Risk | Mitigation | Disposition |
|------|------------|-------------|
| Gate fingerprint blind to an out-of-tree input (toolchain/PATH) | Every-Nth-tick force-run bounds staleness; restart re-baselines | Accepted |
| Stuck-vs-idle threshold mis-flags a legitimately quiet loop | Advisory UI flag only — no behavior change; tune per-loop | Accepted |
| Validator false-positive on unconventional dependency phrasing | Warning-first, never blocks; reuses the parser the diagram already trusts | Accepted |
| Cutting #3 — a pattern the user explicitly requested | Explicit gate with documented salvage path (Open Questions) | Needs user call |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---------|----------|------------|
| Gate runs on the working tree; HEAD fingerprint is blind | Critical | Fingerprint = working-tree content hash + lockfile, not HEAD |
| Fleet-wide vs per-repo loops; `loop`-only key clobbers | Critical | Key `loop:repo` for per-repo loops; leave fleet-wide loops as-is |
| #1 over-built; one costly call → inline fingerprint | Critical | Private in-memory field, no module/file (~15–20 LOC) |
| Kill `loop-skips.json` + endpoint; idle from `lastAt` | Critical | `skipReason` field + `now` into the digest; no new file/endpoint |
| Shared mutable JSON races / torn writes | Significant | Zero new shared files; state is process-private |
| Skip is an event; dual-file is redundant | Significant | Emit skip as a normal append-only automation event |
| `produces` vs receipt `filesTouched` (tool-frames, not git) | Significant | Moot in v1 (#3 cut); if overridden, source from git branch diff |
| `requires` checked vs empty LLM `owns` enforces nothing | Significant | Resolved by cutting #3 |
| Triple-duplicated / divergent validator | Significant | Single impl on the canonical edge map; skills read the result |
| Speculative subscriptions / injected-dep seam | Significant | Cut; binary inline guard |
| `surpriseCause` narration nothing consumes | Significant | Cut |
| Issue-ids churn the gate facet every tick | Minor | Issue-ids excluded from the gate hash; removes the need for subscriptions |
| Wall-clock stuck-detector vs NTP step-back | Minor | `lastAt` rides the monotonic event id; `now` is display-only |
| Fingerprint sampled mid-land | Minor | Computed inside the land-lock |

## Open Questions (resolve before DECOMPOSE)

1. **#3 (`requires`/`produces`) — cut, or override?** Both red teams and the arbiter
   recommend cutting it from v1: dispatch ordering keys on issue-id blockers and is
   decoupled from `owns`; `owns` is itself LLM-inferred ("omit if unsure"), so
   `requires`/`produces` would be a third disconnected notion of "what a task touches,"
   enforced by nothing, while spending tokens and manufacturing low-value findings.
   The only honest win is two standalone halves: (a) a post-run advisory audit that
   diffs declared `produces` against the **agent branch git diff** (not the receipt's
   tool-frame `filesTouched`); and (b) **operator-declared** `requires` that actually
   feed the dispatch admission gate. **User's call** — default is to cut and file the
   salvage as an OMPSQ follow-up.
2. **Stuck threshold** — start with one default (≈3× a loop's interval since `lastAt`)
   and tune per-loop later? Default: yes.
3. **Force-run cadence** — N=10 ticks, or interval-derived (force at least every ~5 min)?
   Default: N=10.
