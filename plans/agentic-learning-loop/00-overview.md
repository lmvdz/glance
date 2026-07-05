# Agentic learning loop

STATUS: done
PRIORITY: p1
REPOS: omp-squad

> WIP gate: scanner showed 6 plans with open concerns (oldest omp-planner 2026-06-24). Operator chose "check overlap, then proceed" — reconciled against `lifeos-proof-provenance` (complementary: it surfaces proof to operators; this consumes proof as a learning signal) and `best-of-n-selection` (no overlap; voting was cut from scope). Then chose the red-team-descoped slice.

## Outcome

- The fleet learns from its own exhaust within a run and across runs: failed fixups get a root-cause note before the next attempt; verified successes rank higher when priming future agents; recurring failures warn the next agent; retrieval carries provenance so agents can judge staleness.
- Every behaviour is behind an `OMP_SQUAD_*` flag and measurable against a baseline, so its effect is attributable rather than assumed.
- No new dependencies, no model training.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 Learning-loop metrics + flag scaffolding | Baseline you can A/B against; without it the loop is unfalsifiable | architectural | `src/metrics.ts` (new), `src/workflow/engine.ts`, `src/observer.ts`, `src/proof.ts`, `src/server.ts`, tests |
| 02 Retrieval provenance + fence-in-builder | Foundation for the fabric/primer changes the others build on | architectural | `src/fabric-search.ts`, `src/fabric.ts`, `src/digest.ts`, tests |
| 03 Reward-boost on digests | Verified first-try successes should rank higher in priming | architectural | `src/digest.ts`, `src/fabric.ts`, `src/proof.ts`, tests |
| 04 Reflexion between fixups | Highest-value: turn blind retries into learning retries | architectural | `src/workflow/verify-workflow.ts`, `src/orchestrator.ts`, `src/reflection.ts` (new), `src/fabric.ts`, tests |
| 05 Recurring-failure memory (downscoped) | Warn the next agent only when the same failure recurs | architectural | `src/fabric.ts`, `src/fabric-search.ts`, `src/observer.ts`, `src/reflection.ts`, tests |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Foundational + independent; establishes metrics and the flag pattern the rest reuse. Read-mostly, no fabric contention. |
| 2 | 02 | Establishes `KbDoc` timestamp threading + fence-inside-builder; every later fabric change builds on it. |
| 3 | 03 | Reward as a `KbDoc.weight` contribution — needs 02's clean weight/threading. |
| 4 | 04 | Reflection store + injection; reuses 02's fence + per-worktree store pattern. |
| 5 | 05 | Reuses 04's reflection call for root-cause and 01's observer streak instrumentation. |

Batches are sequential because `src/fabric.ts` is touched by 02–05 (see Shared-File Analysis). Each batch gets a PRIOR CHANGES summary of the fabric edits before it.

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | — | `grep -n "Caller is responsible for fencing" src/fabric-search.ts` still true (fence not yet internal) |
| 03 | 02 | `grep -n "ranAt\|source" src/fabric-search.ts` shows provenance fields exist on `FabricSearchResult` |
| 04 | 02 | fence lives inside `buildContextPrimer` (02 moved it); `src/reflection.ts` does not yet exist |
| 05 | 04, 01 | `src/reflection.ts` exports a reusable root-cause fn; observer streak count is instrumented (01) |

## Shared-File Analysis

- `src/fabric.ts` — touched by 02 (KbDoc timestamps), 03 (digest weight), 04 (reflection doc type + scoped loader), 05 (failure doc type + scoped loader). **Sequential; each concern appends a parallel loader/doc-type, never restructures the snapshot shape.** New loaders must copy `loadScoutFacts` scope-filtering.
- `src/fabric-search.ts` — 02 (provenance fields + fence-in-builder), 05 (surface failure on fingerprint match). 02 owns the shape change; 05 only consumes it.
- `src/digest.ts` — 02 (fence primitive already there), 03 (proof-outcome tag). 03 owns the tag; 02 only relocates fencing.
- `src/proof.ts` — 01 (read `ok`+fresh for metrics), 03 (read fresh-checked outcome as reward). Both **read-only** on the gate; no gate logic changes.
- `src/observer.ts` — 01 (count streak frequency), 05 (use fingerprint streak as retrieval key). 01 adds a counter; 05 reads the existing streak.
- `src/reflection.ts` (new) — created by 04, reused by 05. 04 must export the root-cause fn generically.
- `src/types.ts` — **owned by `lifeos-proof-provenance` concern 01.** This plan must **append** fields only, never restructure. If a shared type collides, coordinate — do not overwrite lifeos's proof/provenance additions.

## Notes

- Deterministic proof remains the only land gate. Nothing here weakens it; proof is read as a *reward*, never rewritten.
- Every doc injected into a primer must pass through `fenceUntrusted` (indirect prompt injection has no robust defense per the source paper).
- Absence of a reward signal means **unknown**, never **negative** — never drop memory on missing proof.
- Cut/deferred: capability-match routing (cut), trajectory exemplars (deferred to a follow-up), MCP/A2A retry split (moved to reliability backlog). See DESIGN.md.
