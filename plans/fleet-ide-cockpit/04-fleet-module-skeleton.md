# C04 — fleet module skeleton

STATUS: open
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
TOUCHES: src/modules/fleet/ (new: index.ts barrel, store, api client, FleetPane), tab-kind + command palette registration (minimal upstream touches), settings surface for daemon URL/token
BLOCKED_BY: C01

## Goal

`src/modules/fleet/` exists as a first-class terax module: a "Fleet" tab kind openable from the command palette, a settings pane (or settings section) holding daemon URL + token (OS keychain via the existing secrets seam, NOT plaintext store), a typed API client for the daemon's REST surface, and a health probe rendering connected/unreachable/unauthorized states. No fleet features yet — this concern is the load-bearing wiring.

## Approach

- Recon first: read how an existing simple module (e.g. preview) registers its tab kind, palette command, and persistence serializer; mirror it exactly — the module conventions are the rebase insurance.
- API client: thin fetch wrapper against the daemon (webview fetch is already CSP-permitted for localhost); auth header from the secrets seam; single `FleetConnection` zustand store with status + error surfaces. SSE via `EventSource` — verify the webview supports it against a live daemon (scratch-daemon on this host); if not, fall back to fetch-stream and note it.
- Persist `{kind:"fleet"}` tabs in the Space serializer the same way preview persists `url` (registration is one of the few upstream-file touches — keep it surgical).
- Do not add any Rust: if a capability gap forces `src-tauri` changes, stop and file it as a new concern doc first (meta discipline: the webview client should be enough per verified CSP).

## Acceptance

- Palette → "New fleet pane" → tab renders connection state against a live scratch daemon (connected, wrong-token, daemon-down all demonstrated); tab survives Space reload; vitest unit tests for the client's auth/error paths; `git diff --stat upstream/main` shows changes confined to src/modules/fleet/ + the registration points.
