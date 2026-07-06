# Planner core — schema, prompt, parser, frontier diff

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/planner.ts, src/planner.test.ts

## Goal (what is built)

A new pure module `src/planner.ts` — the decision-heavy heart of the resident
planner, with **zero filesystem or daemon I/O** so it is fully unit-testable. It
exports:

- `interface ConcernDraft` — the exact schema in `DESIGN.md` §2 (`num`, `slug`,
  `title`, `priority`, `complexity`, `touches`, `blockedBy`, `goal`, `approach`,
  `acceptance`).
- `buildDecomposePrompt(objective: string, verified: VerifiedConcern[], existing: PlanConcern[]): string`
  — assembles the LLM prompt, listing verified-done concerns as "already complete,
  do NOT re-emit" and existing open concerns as "already planned, refine/keep
  their numbers". Demands a strict JSON array response.
- `parseConcernDrafts(raw: string): ConcernDraft[] | undefined` — pure decode of
  the model's JSON output (via `extractJsonObject`-style tolerance for fences/
  prose), validating every field, normalizing `slug`/`priority`/`complexity`, and
  renumbering `num` to a dense 1..N in dependency-topological order. Returns
  `undefined` on any structural violation (so callers fall back, never crash).
- `decompose(deps: DecomposeDeps): Promise<ConcernDraft[]>` — orchestrates one
  decomposition: builds the prompt, calls the **injected** `classify` fn, parses;
  on any failure returns `[]` (never throws). `DecomposeDeps = { objective, verified,
  existing, classify: (prompt: string) => Promise<string> }`.

`VerifiedConcern` is a minimal `{ num?: number; title: string; planeId?: string }`.

## Approach (how — cite real file:symbol attach points)

- Mirror the injected-`Classify` pattern in `src/intake.ts` — `routeIntake`
  (intake.ts:43) takes `classify?: Classify` and `ompClassify` (intake.ts:92)
  supplies the real one. `decompose` takes the same injectable so the test drives
  it with a stub; the loop (leaf 03) supplies `ompClassify(bin)` or a dedicated
  decompose classify.
- Reuse `extractJsonObject` (omp-call.ts:35) for tolerant decode; for the array
  case, slice from the first `[` to the last `]` and `JSON.parse`. Follow the
  `decideTyped` (omp-call.ts:53) contract shape (parse → fallback) conceptually,
  though `decompose` returns `[]` rather than a fixed fallback object.
- The `ConcernDraft` field set maps 1:1 onto the frontmatter `parsePlanConcerns`
  (features.ts:360) reads back: `priority`→`C_PRIORITY`, `complexity`→
  `C_COMPLEXITY`, `title`→`C_TITLE`, `touches`→`planTouches`, `acceptance`→the
  "Acceptance Criteria" `markdownSectionItems`, `blockedBy`→overview dependency
  table. Match those tokens exactly so leaf 02's output round-trips.
- Renumbering: build the blockedBy adjacency, topologically sort (Kahn), assign
  dense `num` in sort order; if the model returns a cycle, `parseConcernDrafts`
  returns `undefined` (leaf 02's gate is the second line of defense, but the
  parser rejects an obviously-cyclic draft set early).

## Verify (concrete command + expected observable outcome)

`bun test src/planner.test.ts` passes, with cases:
1. `parseConcernDrafts` on a canned 3-concern JSON string (with a ```json fence and
   trailing prose) returns 3 drafts, dense `num` 1..3, `blockedBy` preserved.
2. `parseConcernDrafts` on malformed JSON / a missing required field / a
   self-referential `blockedBy` returns `undefined`.
3. `buildDecomposePrompt` output contains the objective text, each verified
   concern's title under a "do not re-emit"/"already complete" marker, and demands
   a JSON array.
4. `decompose({ ..., classify: async () => CANNED_JSON })` resolves to the parsed
   drafts; `decompose({ ..., classify: async () => "not json" })` resolves to `[]`
   (no throw).

## Scope boundary (what NOT to touch)

No filesystem, no `plans/` writes (leaf 02), no daemon wiring (leaf 03/04), no CLI
(leaf 05). Do not import `node:fs` or `squad-manager`. Do not emit `STATUS`/`PLANE`
values (STATUS is always `open` downstream; `PLANE` is never emitted). Do not call
`omp` directly — the LLM is injected.
