# FileTreeBlock
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/blocks/FileTreeBlock.tsx

## Goal

Render a file-change tree with per-file add/modify/remove/rename badges. When the
fence body is empty, derive the tree from the concern's `TOUCHES` (available via
context). Replace the stub from concern 04 — edit only this file.

## Approach

1. Read inputs:
   - `body` lines, each optionally annotated with a change marker:
     `src/foo.ts +added`, `src/bar.ts ~modified`, `old.ts -removed`,
     `a.ts -> b.ts rename` (define exact tokens; default = modify).
   - If `body` is empty/whitespace, fall back to `useContext(PlanBlockContext).touches`
     (each path defaults to "modify").
2. Build a nested tree from the path list (split on `/`), then render as an
   indented tree (reuse the visual idiom of `HeatPanel.tsx`'s recursive tree if
   helpful, but keep this self-contained). Directories collapsible is optional;
   a flat indented tree is acceptable for v1.
3. Per-file badge with token colors: added → `--wf-ok`, removed → `--wf-warn`/red,
   modified → `--wf-accent`/muted, rename → muted with `old → new`. Use
   `lucide-react` file/folder icons (already a dependency).
4. Container: `className="not-prose"`, `data-block-id={blockId}`. Use a monospace
   font for paths (`font-mono` / `var(--font-mono)`).
5. If there are no paths at all (empty body AND no touches), render a small muted
   "no files" note rather than nothing.

## Cross-Repo Side Effects

Consumes `PlanBlockContext.touches` populated by concern 04. Imports `BlockProps`.

## Verify

- `cd webapp && bun run build` succeeds.
- A ```filetree``` block with explicit body lines renders the tree with correct
  per-file badges.
- An EMPTY ```filetree``` block inside a concern with `TOUCHES` renders the tree
  derived from those paths (test against the concern 01 fixture or a concern that
  has TOUCHES).
- Badges use `--wf-*` colors and invert under `.dark`.

## Resolution

Landed in c4f80e4 (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
