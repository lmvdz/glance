# Plan-doc writer + DAG validation gate (idempotent)

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/plan-writer.ts, src/plan-writer.test.ts

## Goal (what is built)

A new module `src/plan-writer.ts` that materializes `ConcernDraft[]` (from leaf 01)
into `plans/<name>/NN-slug.md` concern docs plus a `00-overview.md` carrying the
`## Dependency graph` table — idempotently and behind the existing DAG gate.

- `writeConcernDrafts(repo: string, planDir: string, drafts: ConcernDraft[]): Promise<WriteResult>`
  where `WriteResult = { written: string[]; removed: string[]; issues: PlanGraphIssue[]; ok: boolean }`.
- Idempotent: re-running with the same drafts produces byte-identical files and
  `written`/`removed` empty on the second call (or all files reported unchanged).
- One-directional STATUS discipline: when a concern file already exists with a
  **terminal** STATUS (`done`/`complete`/`completed`/`closed`/`cancelled`/
  `canceled`), the writer refreshes its body but **preserves the STATUS line** and
  never removes the file. New/open concerns are written `STATUS: open`.
- Orphan pruning: a planner-authored concern file (matches `NN-slug.md`, is NOT
  `OBJECTIVE.md` / `00-overview.md` / `DESIGN.md`, carries a non-terminal STATUS)
  whose `num` is absent from the new drafts is deleted (the frontier shrank).
- DAG gate: after staging the write, call `validatePlanConcerns` (features.ts:410);
  if `issues.length > 0`, **roll back** to the pre-write snapshot, set `ok=false`,
  return the issues. A cyclic/dangling plan never survives on disk.

## Approach (how — cite real file:symbol attach points)

- Emit frontmatter that `parsePlanConcerns` (features.ts:360) parses: first line
  `# {title}`, then `STATUS: open`, `PRIORITY: {priority}`, `COMPLEXITY:
  {complexity}`, `TOUCHES: {touches joined by ", "}`, then `## Goal`, `## Approach`,
  `## Acceptance Criteria` (bullets). These match `C_STATUS`/`C_PRIORITY`/
  `C_COMPLEXITY`/`C_TITLE` (features.ts:300–306) and `planTouches`/
  `markdownSectionItems` (features.ts:330,312).
- The overview table MUST use the heading `## Dependency graph` and rows
  `| {num} {title} | {blockedBy nums or "none"} |` — this is exactly what
  `parseDependencyTable` (planGraph.ts:65) scans (`/^#{1,6}\s*Dependency graph/i`,
  concern number in col0, blocker numbers in col1). Getting this heading wrong is
  the single most common failure (see the "Dependency graph" heading gotcha in
  project memory).
- The gate is **reuse**: `validatePlanConcerns(repo, planDir)` (features.ts:410)
  already maps concerns → `GraphConcernInput` and returns `buildPlanGraph(...).issues`
  (planGraph.ts:116). Call it; do NOT re-implement cycle/dangling detection.
- Snapshot/rollback: read the current planner-authored `.md` files (name + bytes)
  into memory before writing; on gate failure, restore exactly (rewrite kept,
  delete created, restore removed). Mirror the best-effort file discipline in
  `plan-sync.ts` (writes STATUS in place, skips unwritable docs) and the
  archive/restore rename pattern in `features.ts` (`archivePlanDir` :203).
- NEVER touch `OBJECTIVE.md` (leaf 03 owns it as the input marker) or `DESIGN.md`.

## Verify (concrete command + expected observable outcome)

`bun test src/plan-writer.test.ts` passes, using a `mkdtemp` scratch repo, with cases:
1. Write a 3-draft set → 3 `NN-slug.md` + `00-overview.md` exist;
   `parsePlanConcerns(tmp, "plans/x")` returns 3 concerns with matching
   title/priority/complexity/touches; `validatePlanConcerns(tmp, "plans/x")`
   returns `[]`.
2. Second identical write → `written`/`removed` empty (or all-unchanged), files
   byte-identical (idempotent).
3. A draft set whose overview implies a cycle (or a `blockedBy` to a missing num)
   → `ok=false`, `issues` non-empty, and the plan dir is byte-identical to its
   pre-write snapshot (rollback proven).
4. Pre-seed a `02-foo.md` with `STATUS: done`; re-write a draft set that omits
   concern 2 → the file survives with `STATUS: done` intact (terminal preserved,
   not pruned); an open orphan IS pruned.

## Scope boundary (what NOT to touch)

No LLM calls, no daemon wiring, no CLI. Do not modify `features.ts` or
`planGraph.ts` (consume them as-is). Do not write `PLANE:` lines or any non-`open`
STATUS for new concerns. Do not touch `OBJECTIVE.md`/`DESIGN.md`. Reuse
`validatePlanConcerns` — do not fork its logic.
