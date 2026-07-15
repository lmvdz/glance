# Symptom consumption: glance symptom, doctor-failure auto-match, fabric fact
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 05
TOUCHES: src/index.ts, src/doctor.ts, src/fabric.ts, src/fabric-search.ts, src/server.ts, webapp/src/lib/commandPalette.ts

## Goal
The where-do-I-look loop closes at the moment of motivation: a failing doctor check auto-surfaces the best-matching symptom card in its remedy; `glance symptom <query>` searches the index; symptom cards are fabric-searchable (⌘K, viewer-tier discovery).

## Approach
1. **`glance symptom <query>`** (`src/index.ts`, new case next to `doctor`): GET `/api/symptoms?q=…` (new route, viewer tier) → server ranks `listSymptoms` with the same BM25 machinery fabric-search uses (reuse its scorer over symptom+whereToLook text; keep ranking server-side). Render: symptom, where-to-look list with a `(path missing)` flag per entry that no longer exists in the repo tree (stat at render — a dead pointer mid-incident is worse than none), fixedBy PR, age. `--json` flag. Query-time grouping: same normalized symptom text → newest first.
2. **Doctor auto-match** (`src/doctor.ts`): after check-group evaluation, for each check with `status !== "ok"`, match `title + detail` against the symptom index; when the top hit clears a modest score threshold, append to that check's `remedy`: `known symptom: "<symptom>" → <whereToLook[0]> (glance symptom for more)`. Pure matching helper, tested; probe supplies symptoms so `runDoctor` stays I/O-injected. Plus one summary row (`symptom-index`, count + `glance symptom <query>` remedy) — informational, never warn/error.
3. **Fabric**: `FabricSymptomFact { symptom, whereToLook, landedAt }` + snapshot field + assembly block reading `listSymptoms(stateDir, {repo})` — through the `repoSet` filter exactly like the decisions block (the leak-incident guard). `KbDocType` `"symptom"` + flatten + `PRIMER_LABEL: "Known symptom"` + webapp `TYPE_LABELS` entry. Cold-start primer thereby teaches new units known failure modes for free.
4. Acceptance test (the loop proof, per red team): a seeded symptom entry + a deliberately failing doctor check whose title matches → the check's remedy contains the symptom pointer.

## Cross-Repo Side Effects
None.

## Verify
`bun test` green: BM25 symptom ranking, doctor match threshold + remedy append (the acceptance test above), fabric scoping (foreign-repo symptom never in snapshot), grouping newest-first, dead-path flagging. Manual: `glance symptom "dispatch stalled"` returns the seeded card.

## Resolution
Shipped: fbaafb3 (salvage-retry) + review fix (actor-scoped /api/symptoms). glance symptom CLI, doctor failing-check auto-match with acceptance test, fabric symptom fact.
