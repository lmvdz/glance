# Visual-plan block vocabulary in the webui

## Outcome

Concern docs render in the webapp as a rich, reviewable artifact: authors embed
typed blocks (wireframe/diagram, file-tree, Open-Questions form, annotated-code,
callouts, before/after columns) as fenced code; the renderer owns the look. Plus
review comments can be pinned to a block. Rendered natively in our React webapp —
no external service. See `DESIGN.md` for rationale and red-team resolutions.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 authoring spec | Blocks rot unless `/plan`+squad emit them; renderer is validated against a real example | research | docs + example fixture + skill-guidance deliverable |
| 02 css tokens | The `--wf-*` token layer blocks map onto; flips with `.dark` | mechanical | `webapp/src/index.css` |
| 03 sanitizer | Author HTML is an XSS surface; add deps | mechanical | `webapp/package.json`, `webapp/src/lib/sanitize.ts` |
| 04 registry+harness | The one render seam; dispatches custom fences; ships block stubs | architectural | `webapp/src/components/PlanBlocks.tsx`, `webapp/src/components/blocks/*` (stubs), `TaskDetail.tsx` |
| 05 callout+columns | Cheapest, highest-grain blocks | mechanical | `blocks/CalloutBlock.tsx`, `blocks/ColumnsBlock.tsx` |
| 06 file-tree | Change tree from existing `TOUCHES` | mechanical | `blocks/FileTreeBlock.tsx` |
| 07 annotated-code | Line-anchored margin notes | architectural | `blocks/AnnotatedCodeBlock.tsx` |
| 08 wireframe+diagram | Signature pattern: author HTML + tokens + rough.js | architectural | `blocks/WireframeBlock.tsx`, `webapp/package.json` |
| 09 questions | Open-Questions form; answers → `## Decisions` | architectural | `blocks/QuestionsBlock.tsx`, `src/server.ts`, `src/features.ts` |
| 10 anchored comments | Pin comments to a block; fix Plane over-sync | architectural | `dto.ts`, `src/comments.ts`, `TaskDetail.tsx`, `src/squad-manager.ts` |
| 11 tests | Lock in the parser/sanitizer/round-trips | mechanical | `tests/*` |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 0 | 01, 02, 03 | Independent foundations (docs, CSS, sanitizer); no shared files |
| 1 | 04 | The render harness + block stubs — everything else fleshes out a stub |
| 2 | 05, 06, 07, 08 | Each fleshes out its OWN new block file → safe parallel |
| 3 | 09 | Owns `src/server.ts` + `src/features.ts` route/writer additions |
| 4 | 10 | Owns the `TaskDetail.tsx` comment region (sequential after 04) + schema |
| 5 | 11 | Tests, after everything lands |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 04 | 02, 03 | `test -f webapp/src/lib/sanitize.ts && grep -q -- '--wf-paper' webapp/src/index.css` |
| 05 | 04 | `grep -q 'BLOCK_REGISTRY' webapp/src/components/PlanBlocks.tsx` |
| 06 | 04 | `grep -q 'BLOCK_REGISTRY' webapp/src/components/PlanBlocks.tsx` |
| 07 | 04 | `grep -q 'BLOCK_REGISTRY' webapp/src/components/PlanBlocks.tsx` |
| 08 | 04, 02, 03 | registry + `--wf-*` tokens + `sanitize.ts` all present |
| 09 | 04 | `grep -q 'BLOCK_REGISTRY' webapp/src/components/PlanBlocks.tsx` |
| 10 | 04 | registry present; `TaskDetail.tsx` PlanMarkdown uses the harness |
| 11 | 04-10 | all block files present under `webapp/src/components/blocks/` |

## Notes

- **react-markdown v10 facts (verified, do not re-derive):** the `inline` prop was
  removed in v9; dispatch via a `pre` component override reading the child `code`
  node. Fence params live on `node.data.meta` (NOT className, which keeps only
  `language-<firstToken>`). Fence body is the raw string at
  `codeNode.children[0].value`.
- **Tailwind v4:** `theme()` is deprecated and theme vars are tree-shaken. Define
  `--wf-*` inside `@theme`/`@theme static`, not via `theme()` under `:root`.
- **rough.js cannot read `var()`** — resolve colors via `getComputedStyle` and
  redraw on theme toggle.
- **Always scope injected block HTML with `not-prose`** (the markdown article is
  wrapped in `@tailwindcss/typography` `prose`).
- Concern 04 must **preserve the existing SyntaxHighlighter path** for normal code
  fences — only custom block languages divert.
- Build/verify: `cd webapp && bun run build` (or the project's build script) and
  `bun test` from repo root (ensure `node_modules/.bin` is on PATH per the known
  test-PATH gotcha).
