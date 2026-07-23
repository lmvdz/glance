# C01 — repo bootstrap: fork terax into glance-desktop

STATUS: done — merged as glance-desktop#2 (ALL acceptance met: cargo green, WSLg window mapped); verified on main, 2026-07-21 reality audit
PRIORITY: p1
REPOS: glance-desktop (new)
COMPLEXITY: mechanical
TOUCHES: new private GitHub repo, local clone at ~/sui/glance-desktop, UPSTREAM.md (new), README provenance note
BLOCKED_BY: none

## Goal

A private `glance-desktop` repo under Lars's account containing terax's history, an `upstream` remote for rebases, and a green build on this machine. Outward-facing action (repo creation) authorized by Lars 2026-07-14 ("fork terax into our own desktop app", "go straight to the fleet-first IDE"); stays PRIVATE — visibility is Lars's call later.

## Approach

- `gh repo create <owner>/glance-desktop --private --description "glance desktop cockpit (terax fork)"` — NOT `gh repo fork` (public parent forces public fork).
- `git clone https://github.com/crynta/terax-ai ~/sui/glance-desktop && cd ~/sui/glance-desktop && git remote rename origin upstream && git remote add origin <new repo> && git push -u origin main`.
- Record in `UPSTREAM.md`: bootstrap SHA (`git rev-parse upstream/main` at clone time), date, the additive-only discipline, and the rebase cadence (C03 owns the mechanism).
- Build on WSL2: install Tauri Linux prereqs (webkit2gtk-4.1, libappindicator3, librsvg2, patchelf — confirm against terax's own CI workflow file, which is in the tree); `pnpm install`, `pnpm build`, `cargo check` in `src-tauri/`, `pnpm vitest run`. Document every installed apt package in UPSTREAM.md.
- Launch proof: WSLg is available on this host — `pnpm tauri dev` long enough to see the window (screenshot via agent-browser is not applicable to a native window; a plain screenshot or the process surviving 30s + log line is acceptable proof). If GUI launch fails under WSLg, record the failure verbatim and gate on build+tests only — do not block the epic on WSLg quirks; note Windows-side launch as the fallback verification for a later concern.
- Do NOT enable any CI on the private repo yet (C03 owns it).

## Acceptance

- Repo exists (private), `origin`/`upstream` remotes correct, main pushed.
- `pnpm build` + `cargo check` + `pnpm vitest run` green on this machine; UPSTREAM.md records SHA, deps, and launch-proof outcome.
