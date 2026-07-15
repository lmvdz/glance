# C02 — rebrand-lite

STATUS: done (glance-desktop#10, merged)
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: mechanical
TOUCHES: src-tauri/tauri.conf.json (productName, identifier, window title), package.json name, app icons, About/title strings surfaced in the UI shell

## Reality notes (2026-07-14, glance-desktop#10)

Glance brand asset found: `webapp/src/assets/logo-mark.png` + `brand.md` (ember `#F0A35A`). Icons regenerated via `tauri icon` (PIL padded the 514×483 mark to a 1024² canvas first). Changed: productName, identifier (`app.glance.desktop` — re-homes the store dir), window title, package name, `useWindowTitle` APP_NAME, AboutSection name+identifier. Deferred to Epic M (deep rename): Rust crate name, in-app AI-assistant "Terax" strings, theme ids, internal store filenames. Gate green incl. cargo check. Boot verified under WSLg; window title is Spotify-style (shows active folder, "Glance" only when idle) and Linux WM_CLASS stays `terax` (binary-derived) — both deep-rename territory, noted honestly in the PR.
BLOCKED_BY: C01

## Goal

The app presents as Glance — productName "Glance", identifier `app.glance.desktop` (this also re-homes the tauri-plugin-store data dir, cleanly separating our Spaces/settings from a user's real terax install), window title, icon from glance brand assets (brand.md, ember accent) — while touching as few upstream files as possible.

## Approach

- Change ONLY: `tauri.conf.json` (productName, identifier, window title), `package.json` name, icon assets, and any single obvious About-string constant. Resist the deep rename (imports, module names, docs) — meta-plan decision: deferred to Epic M.
- Generate icons from the glance mark via `tauri icon` if brand raster exists; otherwise a plain ember-tinted placeholder and a note in UPSTREAM.md.
- Verify the store re-home: launch, create a Space, confirm `terax-spaces.json` lands under the `app.glance.desktop` data dir.

## Acceptance

- Build green; window titled Glance with the new icon; store writes under the new identifier; diff vs upstream limited to the files listed above (attach `git diff --stat upstream/main` to the PR).
