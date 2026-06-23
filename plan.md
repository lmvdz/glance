# Implementation plan — [CC-rewrite 01] Scaffold + build + serve seam (OMPSQ-54, FOUNDATIONAL)

Scope (from issue): scaffold a NEW `webapp/` Vite SPA (React 19 + TS + Tailwind v4 + shadcn),
content-hashed static build, add an **INERT, opt-in, DEFAULT-OFF** serve branch in `src/server.ts`,
add `tests/webapp.test.ts` (build + typecheck gate). KEEP `tests/web.test.ts`.
**Do NOT modify `src/web/index.html`.** TOUCHES: `webapp/**` (new), `src/server.ts` (seam only),
`tests/webapp.test.ts` (new).

Verification gate: `bun run check && bun test`.

## Grounded anchors
- Serve consts: `src/server.ts:37-38` (`INDEX_HTML`, `WEB_DIR`), public assets `:40-47`.
- uiVersion seed from index: `:286`.
- Request routing in `handle()`: index at `:352` + `:383-385`; PUBLIC_ASSETS at `:386-387`; 404 `:672`.
- Root `tsc` scope: `tsconfig.json:17` `include: ["src"]` → `webapp/` is OUTSIDE root typecheck (good; it owns its own).
- Version pins to mirror (docs-site/package.json): react/react-dom `^19.2.7`, tailwindcss + `@tailwindcss/postcss` `^4.3.1`,
  typescript `^6.0.3`, `@types/react` `^19.2.17`, `@types/react-dom` `^19.2.3`, `class-variance-authority` `^0.7.1`,
  `tailwind-merge` `^3.6.0`, `lucide-react` `^1.20.0`. SPA uses `@tailwindcss/vite` (v4 vite plugin) instead of postcss.

## Steps

1. **Create `webapp/` Vite SPA scaffold** (standalone package, own `node_modules`):
   - `webapp/package.json`: `"type":"module"`, scripts `build` (`tsc -b && vite build`), `typecheck` (`tsc --noEmit`),
     `dev` (`vite`). Deps: `react`/`react-dom` `^19.2.x`. devDeps: `vite` (latest 6), `@vitejs/plugin-react`,
     `typescript ^6.0.3`, `@types/react`/`@types/react-dom`, `tailwindcss ^4`, `@tailwindcss/vite ^4`.
     shadcn runtime: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `tw-animate-css`.
   - `webapp/vite.config.ts`: `plugins:[react(), tailwindcss()]`; `resolve.alias["@"] = ./src`;
     `build.outDir:"dist"` (Vite default content-hashes `dist/assets/*-<hash>.{js,css}`).
   - `webapp/tsconfig.json` (+ `tsconfig.node.json` for vite config): mirror docs-site compiler opts
     (`strict`, `moduleResolution:"bundler"`, `jsx:"react-jsx"`, `paths {"@/*":["./src/*"]}`, `noEmit`).
   - `webapp/index.html`: minimal `<div id="root">` + `<script type="module" src="/src/main.tsx">`.
   - `webapp/.gitignore`: `node_modules`, `dist`.

2. **App entry + Tailwind v4 + shadcn baseline** (proof-of-life only, NOT a port of the live dashboard):
   - `webapp/src/main.tsx`: `createRoot(...).render(<App/>)`, imports `./index.css`.
   - `webapp/src/index.css`: `@import "tailwindcss"; @import "tw-animate-css";` + shadcn v4 `@theme inline` token
     block and `:root`/`.dark` CSS vars (standard shadcn neutral preset).
   - `webapp/src/App.tsx`: trivial component rendering one shadcn `Button` to prove the toolchain compiles + Tailwind
     classes resolve.
   - `webapp/components.json` (shadcn config, Tailwind v4 / vite style), `webapp/src/lib/utils.ts` (`cn()` helper),
     `webapp/src/components/ui/button.tsx` (canonical shadcn Button via `cva`). No registry network call needed —
     author these files directly to keep the gate offline-deterministic.

3. **Inert opt-in serve seam in `src/server.ts`** (DEFAULT OFF; `src/web/index.html` untouched):
   - Add consts near `:38`: `WEBAPP_DIST = path.join(import.meta.dir, "..", "webapp", "dist")`,
     `WEBAPP_INDEX = path.join(WEBAPP_DIST, "index.html")`.
   - Add pure helper `webappEnabled(): boolean` (exported for the test) = `process.env.OMP_SQUAD_WEBAPP === "1" &&
     existsSync(WEBAPP_INDEX)`. **Both** conditions required → off unless explicitly flagged AND built.
   - In `handle()` index branch `:383-385`: when `webappEnabled()`, serve `Bun.file(WEBAPP_INDEX)`; else current `indexFile`.
   - Add a hashed-asset branch (only when enabled): serve `GET /assets/<file>` from `WEBAPP_DIST/assets/` with a
     containment check (resolved path must stay under `WEBAPP_DIST/assets`) to block path traversal; 404 otherwise.
     Place before the auth gate (`:386` area) so built JS/CSS load tokenless like the shell.
   - uiVersion seed `:286`: when enabled, fingerprint `WEBAPP_INDEX`; else keep `INDEX_HTML`. (Tabs still self-refresh.)
   - Keep PUBLIC_ASSETS (manifest/sw/icons) path unchanged — PWA bootstrap stays on `src/web` until cutover.
   - `import { existsSync } from "node:fs"` if not already imported.

4. **`tests/webapp.test.ts` — build + typecheck gate** (`bun:test`, mirrors `web.test.ts` style):
   - Test A: run `tsc --noEmit` in `webapp/` via `Bun.spawn`; assert exit 0 (typecheck passes).
   - Test B: run `vite build` in `webapp/`; assert exit 0, `webapp/dist/index.html` exists, and it references at least one
     content-hashed `/assets/*-<hash>.js` (regex on the emitted html).
   - Idempotent prereq: if `webapp/node_modules` absent, `bun install` in `webapp/` first (ponytail: one-time;
     ceiling = slow cold run, upgrade path = CI caches `webapp/node_modules`). Generous `timeout` on the build test.
   - Test C (pure, no build): import `webappEnabled` from `../src/server.ts`; with `OMP_SQUAD_WEBAPP` unset assert
     `false` (proves DEFAULT OFF regardless of dist state).
   - KEEP `tests/web.test.ts` as-is.

5. **Docs (same-change rule):** README section "Web framework rewrite (in progress)" documenting the `OMP_SQUAD_WEBAPP=1`
   opt-in flag, that it requires a prior `webapp` build, and that it is OFF by default with the live dashboard unchanged.

## Verification
- `bun run check` — root `tsc --noEmit`; `webapp/` is outside `include`, so the seam edit in `src/server.ts` is the only
  root-typechecked change. Must stay green.
- `bun test` — full suite incl. new `tests/webapp.test.ts` (typecheck + content-hashed build) and unchanged
  `tests/web.test.ts`. `webappEnabled()` default-off unit test green.
- Manual: `OMP_SQUAD_WEBAPP=1` after a `webapp` build serves the Vite shell at `/`; flag unset (or no dist) → live
  `src/web/index.html` exactly as before.

## Ponytail notes
- No new root dependency; webapp deps isolated under `webapp/`. Seam is ~10 lines, both-conditions-gated, reversible.
- shadcn files authored directly (no registry/network) → deterministic offline gate.
- Ceiling: serve branch handles only `/` + `/assets/*` (Vite's default hashed output); deep client routes / SPA history
  fallback and PWA-asset migration are later cutover concerns, explicitly out of scope here.
