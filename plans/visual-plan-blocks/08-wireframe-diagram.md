# WireframeBlock + diagram skin + rough.js overlay
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/blocks/WireframeBlock.tsx

## Goal

The signature block: render author-written semantic HTML as a themed wireframe —
sanitized, footprint-sized by `surface`, with a rough.js sketch overlay and
`data-icon`→SVG replacement. Same component renders the `diagram` skin
(`params.kind='diagram'`). Replace the stub from concern 04 — edit only this file.
(`dompurify` + `roughjs` are already added by concern 03.)

## Approach

### Pipeline (order matters — verified)
1. **Icon swap BEFORE sanitize** (one innerHTML pass, no post-render DOM mutation
   that fights React): string-replace `data-icon="x"` markers with inline SVG
   strings, then sanitize the whole string. Maintain a small static map of
   supported icons → raw SVG markup (mail, lock, search, plus, x, check, chevron*,
   user, settings, calendar, bell, send, edit, arrow*, dots). Source SVG path data
   from the `lucide` icon set (the installed `lucide-react` is an anomalous 1.21.0
   build — VERIFY its export shape before importing icons from it; a hand-curated
   static SVG map avoids that dependency risk entirely and is recommended). For an
   unknown icon name, substitute a visible placeholder (e.g. a small `[?]`), never
   a silent blank.
2. **Sanitize** via `sanitize()` from `../../lib/sanitize` (concern 03). Inject
   with `dangerouslySetInnerHTML`.
3. **Surface footprint**: `params.surface` ∈ {browser, desktop, mobile, popover,
   panel} sets a max-width/aspect on the wrapper (e.g. browser ≈ 720px wide with a
   faux titlebar; mobile ≈ 360px; panel/popover narrower). Never let the author set
   width — the surface does.
4. **Theme tokens**: wrap in `className="wf-surface not-prose"` so helper classes
   + tokens (concern 02) apply and `prose` is excluded.

### rough.js overlay (verified caveats)
- `import rough from 'roughjs'` (the ESM bundle; avoid the `roughjs/bin/rough`
  subpath).
- rough.js does NOT resolve `var(--wf-*)` — resolve the stroke color at draw time:
  `getComputedStyle(el).getPropertyValue('--wf-line').trim()`.
- Draw ONE rough rectangle for the outer frame (outer-frame-only — do not roughen
  every child) into an absolutely-positioned `<svg>` over a `position:relative`
  container. Redraw on:
  - mount,
  - `ResizeObserver` (content height changes),
  - **theme change** — subscribe to the app's theme (read `ThemeContext`, or
    observe the `.dark` class on `document.documentElement` via `MutationObserver`)
    and re-resolve the color + redraw, or the sketch keeps the stale light/dark
    stroke.
- Degrade gracefully: if `document`/canvas is unavailable (e.g. a test render) or
  rough.js throws, skip the overlay and fall back to a plain CSS border — never
  crash the block.
- Lazy-init the overlay when the block scrolls into view (`IntersectionObserver`)
  to avoid drawing many off-screen overlays.

5. `data-block-id={blockId}` on the outer element for comment anchoring.
6. For `params.kind==='diagram'`, apply diagram-skin chrome (no faux browser
   titlebar; use `.diagram-panel` styling) — same render/sanitize/rough pipeline.

## Cross-Repo Side Effects

Imports `sanitize` (concern 03) and `BlockProps` (concern 04). First importer of
`roughjs` (dep added in concern 03).

## Verify

- `cd webapp && bun run build` succeeds.
- A ```wireframe surface=browser``` block from the fixture renders the HTML themed
  (cards/pills/buttons styled via `--wf-*`), with a visible hand-drawn outer frame.
- Toggling `.dark` redraws the sketch stroke in the right color (not stale).
- `data-icon="mail"` renders an SVG; an unknown icon shows a visible placeholder.
- `<script>`, `<style>`, `onerror=`, and `style="...url(...)"` in the body are
  stripped (sanitizer working).
- `params.kind=diagram` (```diagram```) renders with the diagram skin.
- No crash if the overlay can't draw (graceful CSS-border fallback).

## Resolution

Landed in e3a6755 (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
