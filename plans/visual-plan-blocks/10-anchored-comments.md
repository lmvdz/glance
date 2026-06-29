# Block-anchored comments + Plane over-sync fix
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/lib/dto.ts, src/comments.ts, webapp/src/components/TaskDetail.tsx, src/squad-manager.ts

## Goal

Let a review comment be pinned to a specific rendered block (by `blockId`), extend
the existing annotation system additively, and fix a pre-existing bug where
plan-annotation comments over-sync to Plane as context-less noise. Reuse the
EXISTING send-to-agent path for routing (do NOT add a passive `resolutionTarget`
field or an "agent inbox"). OWNS the `TaskDetail.tsx` comment region (sequential
after concern 04, which owns the PlanMarkdown region of the same file).

## Approach

### Schema (additive, backward-compatible)
- `webapp/src/lib/dto.ts`: add optional `blockId?: string` to
  `PlanAnnotationTargetDTO` (alongside `planPath/lineStart/lineEnd/quote`).
- `src/comments.ts`: add `blockId?: string` to the backend `PlanAnnotationTarget`
  type. The append-only JSONL + fold-on-read tolerates the new optional field; no
  migration needed.

### Plane over-sync fix (pre-existing bug)
- In `src/squad-manager.ts` `addComment`, the call currently fans out EVERY comment
  to Plane via `addPlaneIssueComment` for all `commentPlaneTargets`. Gate this:
  do NOT sync comments with `kind === "plan-annotation"` to Plane (they are
  plan-doc-local review chatter and arrive in Plane without anchor context). Keep
  syncing regular `kind === "comment"`/undefined. (Optionally, if a future need
  arises, sync annotations WITH a rendered quote/anchor — but for now, suppress.)
  Add a brief comment explaining the gate.

### UI (`TaskDetail.tsx`, comment region only)
- Wire `onAnchorComment` in the PlanBlockContext provider (concern 04 left it
  undefined): given a `blockId`, open the existing annotation composer prefilled to
  anchor at that block (set the annotation draft's `blockId`, clear line/quote).
  Reuse the existing `saveAnnotation` flow / `POST /api/features/:id/annotations`
  — just include `blockId` in the POST body and the saved annotation.
- Render a small "comment" affordance on each rendered block: since blocks carry
  `data-block-id`, add a hover comment icon (a thin overlay, or a control the
  block components already expose). Simplest robust approach: in the provider,
  pass `onAnchorComment`; have a tiny shared `BlockCommentButton` (in PlanBlocks or
  a small component) that blocks render in their corner calling
  `ctx.onAnchorComment(blockId)`. If adding the button to every block is too
  invasive, an acceptable v1 is a click handler on `[data-block-id]` elements
  within the article (event delegation) that opens the composer.
- Show existing anchored comments near their block: filter `ctx.comments` by
  `annotation.blockId` and render a count/affordance on the block; clicking shows
  them. Keep parity with how line/quote annotations are already surfaced.
- For routing a block comment to an agent, REUSE the existing
  `POST /api/features/:id/annotations/:annotationId/send` (mode `agent`/`planner`)
  — it already wraps the message in a structured, `fenceUntrusted`-disciplined
  prompt. Do not build a new agent-routing surface.

## Cross-Repo Side Effects

`blockId` flows: WireframeBlock/etc. set `data-block-id` (concerns 05-08) → UI
anchors via existing annotation POST → stored in `comments.jsonl`. The Plane-sync
gate changes existing comment behavior (annotations stop posting to Plane) — note
this in the commit message; it is the intended fix.

## Verify

- `cd webapp && bun run build` and `bun test` (repo root) succeed.
- Clicking the comment affordance on a rendered block opens the composer anchored
  to that `blockId`; saving stores an annotation with `annotation.blockId` set
  (inspect `comments.jsonl`).
- Existing line/quote annotations still work (backward compat).
- A `kind:"plan-annotation"` comment does NOT create a Plane issue comment
  (verify the gate; e.g. unit-test `addComment` skips Plane for that kind, or
  confirm no `addPlaneIssueComment` call path for annotations).
- Existing send-to-agent on an annotation still functions.
