# glance ask answers into fabric + stale-answer resurfacing
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 09
TOUCHES: src/fabric.ts, src/fabric-search.ts, src/answers.ts, src/weekly-episode.ts, webapp/src/lib/commandPalette.ts

## Goal
The operator's own questions become part of the knowledge fabric — searchable in ⌘K, injected into cold-start primers, and resurfaced in the weekly episode when the code they described has since changed.

## Approach
1. **`FabricAnswerFact`** (`src/fabric.ts`): `{ question, answerExcerpt, answeredAt, possiblyStale }` — excerpt capped (~500 chars; answers are untrusted agent markdown, already fenced downstream by primer conventions). New `answers?: Answer[]` on `FabricDeps` populated via `listAnswers(stateDir, {repo})` (repo comparison already normalized by concern 01). Assembly block with the `repoSet` guard verbatim from the decisions block. `KbDocType "answer"` + flatten + `PRIMER_LABEL: "Answered question"` + `TYPE_LABELS`.
2. **Staleness** (`src/answers.ts` or a small pure helper): `possiblyStale(answer, receipts)` — extract repo-relative path tokens from the answer markdown (conservative regex for `src/...`-like tokens that exist in receipts' file universe); stale when any referenced file has a receipt `endedAt > answeredAt`. No references extracted → never stale (honest default). Pure + tested.
3. **Resurfacing** (`src/weekly-episode.ts` gather step): stale answers for the week → concern 09's `staleAnswers` input ("You asked how transcript deltas work; that subsystem changed this week").
4. **answer-read wiring**: palette answer rows now exist — connect concern 02's answer-read emission helper to row selection.

## Cross-Repo Side Effects
None.

## Verify
`bun test` green: staleness (referenced-file-changed → stale; no-references → not stale; foreign-repo receipts ignored), excerpt caps, fabric scoping regression. Manual: `glance ask` something, touch the referenced file with a unit, force an episode → the question appears in the stale section; ⌘K finds the answer.
