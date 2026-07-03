# CalloutBlock + ColumnsBlock
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/blocks/CalloutBlock.tsx, webapp/src/components/blocks/ColumnsBlock.tsx

## Goal

Flesh out the two cheapest, highest-grain blocks: tone-based callouts (especially
`tone=decision`) and before/after two-column comparisons. Replace the stubs from
concern 04 — edit only these two files.

## Approach

These render trusted markdown/text, not author HTML, so no sanitizer needed.
Render block body markdown by reusing the existing `PlanMarkdown` (import it) or a
minimal markdown render; if reusing PlanMarkdown, guard against infinite nesting
(a callout body won't contain another callout in practice, but ensure it renders
plain text safely).

1. **CalloutBlock** (`params.tone` ∈ {decision, warn, ok, info}, default info):
   - A left-accent-bordered panel using tokens: decision → `--wf-accent`,
     warn → `--wf-warn`, ok → `--wf-ok`, info → `--wf-muted`.
   - Small uppercase tone label (e.g. "DECISION") + the body rendered as markdown.
   - Use `className="not-prose"` on the container and Tailwind utilities consistent
     with the rest of TaskDetail (border-l-4, rounded, padding, dark: variants).
   - Example structure:
     ```tsx
     const tones = { decision: 'var(--wf-accent)', warn: 'var(--wf-warn)', ok: 'var(--wf-ok)', info: 'var(--wf-muted)' };
     // <div style={{borderLeft:`3px solid ${tones[tone]}`}} className="not-prose rounded-md bg-gray-50 dark:bg-gray-900/40 p-3 my-3">
     ```
2. **ColumnsBlock**: split `body` on a line that is exactly `---` into left/right
   (before/after). Render side-by-side on `md+` (CSS grid `grid-cols-2`), stacked
   on small screens. Optional `params.left`/`params.right` for column captions
   (default "Before"/"After"). Each side renders its markdown.
3. Both must carry a `data-block-id={blockId}` attribute on the outer element so
   concern 10 can anchor comments to them.

## Cross-Repo Side Effects

None. Imports `BlockProps` from `../PlanBlocks`.

## Verify

- `cd webapp && bun run build` succeeds.
- Rendering the fixture (concern 01): a `tone=decision` callout shows an accent
  bar + "DECISION" label; a `columns` block shows two side-by-side panels split at
  `---`, stacking on narrow width.
- Both outer elements have `data-block-id`.
- Colors invert correctly under `.dark`.

## Resolution

Landed in 154cb7d (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
