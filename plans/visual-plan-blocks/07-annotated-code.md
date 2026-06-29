# AnnotatedCodeBlock
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/blocks/AnnotatedCodeBlock.tsx

## Goal

Render a code block with line-anchored margin notes — syntax-highlighted code on
the left, note bubbles aligned to specific line ranges. Replace the stub from
concern 04 — edit only this file.

## Approach

1. Reuse the existing syntax highlighter: import `Prism as SyntaxHighlighter` and
   `vscDarkPlus` (same as `MarkdownCode`). `params.lang` selects the language.
2. Parse notes from the body using the convention defined in concern 01's spec
   (`docs/plan-blocks.md`). Recommended convention: notes are declared on lines of
   the form `// @note <start>[-<end>] <text>` interleaved or in a leading header
   block; strip those lines from the code that gets highlighted, and keep a map of
   `{ lines: [start,end], label?, note }`. Follow whatever the spec finalized — the
   spec is authoritative; if it differs, match it exactly.
3. Render: enable `showLineNumbers` on SyntaxHighlighter. For each note, render a
   margin bubble (right gutter) or an inline callout under the referenced lines,
   visually tied to the line range (e.g. a colored line-number highlight via
   `lineProps`/`wrapLines` + a note card). A simpler, robust v1: render the
   highlighted code, then a "Notes" list below, each note showing `Lines X-Y` +
   text, with the referenced lines subtly highlighted (`lineProps` background
   `var(--wf-accent-soft)`). Prefer correctness/legibility over pixel-perfect
   gutter alignment.
4. Container: `className="not-prose"`, `data-block-id={blockId}`. Respect light/dark
   (the highlighter theme is dark; ensure the surrounding chrome uses tokens and
   reads fine in both themes, or pick a light/dark highlighter style off the theme
   if low-effort).

## Cross-Repo Side Effects

None. Imports `BlockProps` from `../PlanBlocks`.

## Verify

- `cd webapp && bun run build` succeeds.
- An ```annotated lang=ts``` block renders highlighted code with the note lines
  stripped from the code, and each note shown against its line range.
- Referenced lines are visually highlighted; notes are legible in light and dark.
- `data-block-id` present.

## Resolution

Landed in 1d05feb (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
