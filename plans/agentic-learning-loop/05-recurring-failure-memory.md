# Recurring-failure memory (downscoped)
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/fabric.ts, src/fabric-search.ts, src/observer.ts, src/reflection.ts, tests/observer.test.ts

## Goal

When the *same* failure recurs, warn the next agent with its root cause — using the observer's existing fingerprint as the retrieval key, not similarity guesswork. High-precision, near-zero new machinery. Deliberately narrow: no BM25-similarity "what-NOT-to-do" injection (rejected in design as false-analogy negative priming).

## Approach

**Retrieval key = recurrence, not similarity:**
- `observer.ts` already dedups by `fingerprint` and fires a land-failure finding at `≥3` fails per branch (`LandLedger`). Use that fingerprint as the key.
- Annotate a failure's root cause **once**, when the streak fires, by calling concern 04's `reflect()` on the failing output (reuse the exported fn; do not fork a second LLM path). Store the annotated failure `{ fingerprint, rootCause, repo, source }` per-worktree/agent (proof pattern), scope-tagged.

**Surface only on fingerprint match:**
- Add a `failure` doc type + a scoped loader in `src/fabric.ts` (copy `loadScoutFacts` scope-filtering — do NOT add an unscoped store; that leaks cross-repo/tenant failures).
- In `buildContextPrimer` / cold-start, inject an annotated failure **only when the current task's context matches an existing failure fingerprint** for the same repo — i.e. we are about to retry a known-recurring failure. Otherwise inject nothing. Fenced (02's in-builder guarantee).

**Cross-type dedup (avoid primer flooding):**
- The same failing run can otherwise appear as a digest (03), a reflection (04), and a failure doc (05). Dedup across types by `(repo, fingerprint)` before ranking so one underlying failure surfaces once. Prefer the annotated-failure surface when a fingerprint collision exists.

Gate behind `OMP_SQUAD_FAILURE_MEMORY` (default off). Emit metric so land-failure-streak frequency can be compared on/off (concern 01).

## Cross-Repo Side Effects

None. New `failure` fabric doc type is additive and scoped.

## Verify

- `bun test tests/observer.test.ts` — streak fire triggers a single root-cause annotation (reflect() called once, not per-fail); annotated failure is scope-filtered on read; a non-recurring task gets no failure injection.
- `bun test tests/fabric-search.test.ts` — cross-type dedup by `(repo, fingerprint)` yields one surface per failure; failure injection is fenced.
- `bun run check`
