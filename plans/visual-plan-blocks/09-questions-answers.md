# QuestionsBlock + answers→Decisions API
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/blocks/QuestionsBlock.tsx, src/server.ts, src/features.ts

## Goal

Render an Open-Questions form from a ```questions``` block and persist answers by
writing them into the concern's `## Decisions` section (git-committed, parsed,
surfaced, and reachable by the worktree agent + Plane — unlike a daemon-local
store). Replace the QuestionsBlock stub from concern 04. OWNS the `src/server.ts`
route addition and the `src/features.ts` writer.

## Approach

### Backend writer (`src/features.ts`)
- Decisions are parsed by `markdownSectionItems(text, ["Decisions","Decision Log","Rationale"])`
  → `PlanConcern.decisions[]`. Mirror the existing concern string-surgery helpers
  (e.g. `setConcernStatus`) to add:
  ```ts
  export async function appendConcernDecision(repo: string, file: string, line: string): Promise<PlanConcern | null>
  ```
  It reads the concern file, finds a `## Decisions` (or "Decision Log"/"Rationale")
  heading; if present, appends `- ${line}` to that section; if absent, appends a
  new `## Decisions\n\n- ${line}` section at end of file. Idempotency: if an
  identical bullet already exists, do not duplicate. Write the file back.
- Format an answer line as: `Q: <prompt> — A: <value>` so it reads as a resolved
  decision.

### Backend route (`src/server.ts`)
- Add `POST /api/features/:id/answers` next to the existing `/concerns` and
  `/annotations` routes (same Bun.serve regex-in-`handle()` pattern):
  body `{ repo, file, blockId, questionId, prompt, value }`. Resolve the feature,
  call `appendConcernDecision(repo, file, "Q: ... — A: ...")`, return the updated
  concern (so the UI can refresh `decisions`). Record an audit entry (mirror how
  `/annotations` / `updateConcern` audit) capturing who answered.
- Note: `file` is the concern filename; reuse the same feature-lookup logic as the
  `/concerns` PATCH handler.

### Frontend (`QuestionsBlock.tsx`)
- Parse the YAML body into `{id,type,prompt,options?,recommended?}[]` (the
  convention from `docs/plan-blocks.md`). Use a tiny YAML parse — if no YAML dep is
  present, parse the simple list format manually (keep it robust to the documented
  shape; do not add a heavy dep).
- Render a form: `single` → radio (preselect `recommended`), `multi` → checkboxes,
  `freeform` → textarea. Always include the write-in for single/multi too if the
  spec says "always-on write-in".
- Prefill answered state from `useContext(PlanBlockContext).decisions` — match the
  `Q: <prompt>` prefix to show already-answered questions as resolved.
- On submit, call `ctx.onAnswer(blockId, questionId, value)`. Concern 04 left
  `onAnswer` undefined; THIS concern wires it: in `TaskDetail.tsx`'s
  PlanBlockContext provider (the region concern 04 created), supply an `onAnswer`
  that POSTs to `/api/features/:id/answers` and refreshes the pipeline. Keep the
  TaskDetail edit minimal and within the provider value only (do not touch the
  comment region — that's concern 10).
- `data-block-id={blockId}` on the form container.

## Cross-Repo Side Effects

Adds `appendConcernDecision` to `features.ts` (pure, unit-testable). New
`/api/features/:id/answers` route. Answers surface via the existing
`decisions`/pipeline payload — no payload shape change required.

## Verify

- `cd webapp && bun run build` and `bun test` (repo root) succeed.
- POST to `/api/features/:id/answers` writes a `- Q: … — A: …` bullet under
  `## Decisions` in the target concern file (creating the section if absent);
  re-POSTing the same answer does not duplicate.
- The form renders all three question types; `recommended` is preselected; a
  submitted answer appears as a resolved decision after refresh.
- A worktree clone of the repo shows the answer in the concern markdown (proves
  git-visibility — the whole point).
