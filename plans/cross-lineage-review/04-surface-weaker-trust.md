# Surface same-lineage as weaker trust
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/confidence.ts, webapp/src/lib/agent-badges.ts

## Goal
A same-lineage review counts for less in the confidence score and says so in the UI — the `Proof.sandboxed:false` treatment, applied to self-lineage review.

## Approach
- `src/confidence.ts`: extend `ConfidenceInput` with optional `sameLineage?: boolean`. In `scoreConfidence`, when `input.validator === "pass"`: `+0.1` if `sameLineage !== true`, `+0.05` if `sameLineage === true` (a self-graded pass is worth less). A `veto` stays `-0.4` regardless (bad news isn't softened by who delivers it). `sameLineage` undefined ⇒ today's exact behavior. Update the one caller in `src/squad-manager.ts` (~:4858, `finalizeRun`) to pass `sameLineage: record.validation?.sameLineage` — NOTE this caller is in squad-manager.ts which concern 03 also edits; do 04 after 03 in the same worktree.
- `webapp/src/lib/agent-badges.ts` `validationBadge`: when `v.sameLineage === true`, append to the tooltip `title`, e.g. `\n⚠ same-lineage review (${v.authorLineage} reviewing ${v.reviewerLineage}) — weaker signal`; when `v.sameLineage === false`, append `\n✓ cross-lineage review (${v.reviewerLineage} reviewing ${v.authorLineage})`. No new badge, no change to the null/skipped logic. Requires the webapp `AgentDTO.validation` type to include the new fields — mirror the `src/types.ts` additions in the webapp's copy of the type if it maintains its own (check `webapp/src/lib/types` or shared import).

## Cross-Repo Side Effects
The webapp reads the new `ValidationRecord` fields; ensure its type declaration matches concern 02's `src/types.ts`.

## Verify
`bun test src/confidence.test.ts`: same-lineage pass → 0.05 less than cross/unknown pass; veto unchanged; undefined unchanged. Webapp: `cd webapp && bunx tsc --noEmit` clean; the tooltip renders the lineage note when `sameLineage` is set (component or lib unit test).
