# HTML sanitizer utility + add dependencies
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/package.json, webapp/src/lib/sanitize.ts

## Goal

Provide the `sanitize()` utility that the wireframe/diagram blocks use to render
author-authored HTML safely, and add the two new dependencies the feature needs
(`dompurify`, `roughjs`). This is a foundation concern so later blocks just import.

## Approach

`dompurify` and `roughjs` are NOT currently in `webapp/package.json` (verified).
Add both.

1. Add deps to `webapp/package.json` dependencies: `dompurify` (^3) and `roughjs`
   (^4). `dompurify` v3 ships its own types; add `@types/dompurify` only if the
   build complains. Install (`cd webapp && bun install`) so the lockfile updates.
2. Create `webapp/src/lib/sanitize.ts` exporting `sanitize(html: string): string`:
   ```ts
   import DOMPurify from 'dompurify';

   // Reject dangerous CSS in inline style values. var()/flex/grid/lengths are fine.
   const BAD_CSS = /(url\s*\(|expression\s*\(|@import|javascript:|image-set\s*\()/i;

   let configured = false;
   function ensureHooks() {
     if (configured) return;
     configured = true;
     DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
       if (data.attrName === 'style' && BAD_CSS.test(data.attrValue)) {
         data.attrValue = data.attrValue
           .split(';')
           .filter((decl) => !BAD_CSS.test(decl))
           .join(';');
       }
     });
   }

   export function sanitize(html: string): string {
     ensureHooks();
     return DOMPurify.sanitize(html, {
       FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
       FORBID_ATTR: ['srcset', 'action', 'formaction'],
       // DOMPurify allows style + svg by default; keep them. Ensure svg icon
       // markup survives (svg/path/g/circle/rect/line/polyline/polygon + d/viewBox/
       // fill/stroke/stroke-width). data-* (data-icon, data-block-id) are allowed
       // by default via ALLOW_DATA_ATTR (true by default).
       ADD_ATTR: ['data-icon', 'data-block-id', 'data-primary', 'data-rough'],
       USE_PROFILES: { html: true, svg: true },
     });
   }
   ```
   Notes (verified facts):
   - DOMPurify allows `style` and inline CSS by default; we only need to strip the
     dangerous functions, hence the hook (it reliably fires for the `style`
     attribute). `var(--wf-*)` survives a round-trip.
   - `<style>` tags are a CSS-exfiltration vector → forbidden (only inline `style`
     is permitted).
   - Event handlers (`on*`) and `javascript:` URLs are stripped by DOMPurify by
     default; the hook is belt-and-suspenders for CSS.
3. Keep `sanitize.ts` framework-free and synchronous so it's trivially unit-tested
   (concern 11) and importable from any block.

## Cross-Repo Side Effects

`roughjs` is added here but first imported by concern 08 (so 08 doesn't have to
touch `package.json` and conflict). `sanitize()` is imported by concern 08
(WireframeBlock) and the annotated/columns blocks if they render any HTML.

## Verify

- `test -f webapp/src/lib/sanitize.ts` and it exports `sanitize`.
- `grep -q '"dompurify"' webapp/package.json && grep -q '"roughjs"' webapp/package.json`.
- `cd webapp && bun install && bun run build` succeeds.
- Quick unit sanity (also covered in 11): `sanitize('<div style="color:var(--wf-ink);background:url(http://x)">a</div>')`
  keeps `color:var(--wf-ink)`, drops the `url(...)`; `sanitize('<img src=x onerror=alert(1)>')`
  drops `onerror`; `sanitize('<style>*{}</style>x')` drops the `<style>`.

## Resolution

Landed in c3a4f31 (2026-06-29). Verified: webapp `bun run build` + backend `tsc --noEmit` green; full suite 753 pass (1 pre-existing unrelated orchestrator failure, OMPSQ-308).
