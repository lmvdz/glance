# PR body projection: render recorded teaching into fleet PR bodies
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 05
TOUCHES: src/pr-body.ts (new), src/land-pr.ts, src/squad-manager.ts

## Goal
Every fleet PR ships a body (today they are all empty) whose spine is the unit's recorded mental-model deltas and symptom card, plus observed-only test provenance and an explained-omission line. Pure projection — nothing is ever parsed back out of a PR body.

## Approach
1. **`src/pr-body.ts`** (new, pure, tested): `buildPrBody(input: { deltas: FeatureDecision[]; symptom?: SymptomEntry; testExecutions: { command: string; outcome: string; source: "transcript" | "repository" }[]; omitted: { title: string; reason: string }[]; digestExcerpt?: string })` →
   ```
   ## Mental model delta
   <!-- omp-squad:model-delta:v1 -->
   - <after-statement> (was: <before>) — evidence: `file:lines`
   (or the single line "no delta recorded" when empty — declared, never silent)

   ## Symptom fixed
   <!-- omp-squad:symptom:v1 -->
   Symptom: … / Where to look: …
   (section omitted entirely when no symptom was recorded)

   ## Verified
   <!-- omp-squad:tests:v1 -->
   - `<command>` — <outcome> (observed in transcript)
   (only actually-observed runs, sourced from receipts; NEVER inferred)

   ## Not covered
   - <omitted title> — <reason>
   ```
   Markers are versioned HTML comments for future tooling; cap deltas at 3 (drop extras, count them in Not covered). All caps/format decisions in the pure builder with tests.
2. **Float-time wiring** (`src/squad-manager.ts` `floatPrOnLandReady` ~L3332 and the ~L6507 backstop): a shared `prBodyFor(rec)` helper resolves the unit's feature (persist `featureId` into the `PendingPr` record at this point — extend `recordPendingPr`/`PendingPr` in `src/land-pr.ts`), pulls `source:"model-delta"` decisions, the run's symptom entries (match on agentId/runId), and test executions from receipts; passes `body` into `ensurePr`.
3. **Adopt-path repair** (`src/land-pr.ts` `ensurePr` adopt arm ~L300–338): when adopting an existing OPEN PR, `gh pr view --json body`; if the `model-delta:v1` marker is absent AND a non-empty body was provided, `gh pr edit --body` idempotently. Never overwrite a body that already carries the marker (a human may have edited around it — their edits win).
4. No reconciler parse-back. `prReconcileTick` is untouched.

## Cross-Repo Side Effects
None (PR bodies are visible on GitHub — content is repo-derived, no secrets; digestExcerpt must not include transcript text beyond the digest's existing extractive summary).

## Verify
`bun test` green: builder (delta rendering with evidence, empty→"no delta recorded", symptom omission, observed-only test lines, cap+Not covered accounting), PendingPr featureId round-trip, adopt-arm marker idempotency (unit-test the decision function; gh calls behind the existing exec seam). Manual: float a scratch unit's PR → body present on GitHub with all sections.

## Resolution
Shipped: d6f2330 + review fix (sourceRef filter). First non-empty fleet PR bodies; adopt-path marker repair; featureId on PendingPr. testExecutions honestly empty (receipts carry no command provenance — follow-up named in overview).
