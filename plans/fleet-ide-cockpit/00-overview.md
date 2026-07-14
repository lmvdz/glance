# Fleet-IDE cockpit (Epic C) — fork terax, build the fleet module

Parent: plans/fleet-first-ide/00-meta.md · Evidence: plans/research-terax-ai/BRIEF.md (terax @ a2c8329)

## Outcome

A private `glance-desktop` repo (terax fork, `upstream` remote, additive-only discipline, rebase protocol) that builds green and ships a native `src/modules/fleet/` module: connect to a glance daemon, live roster + attention queue over SSE, open any unit's worktree as a Space in one click, intervene at webapp parity, native notifications deep-linking back to the unit. At the end of this epic the suite exists.

## Verified load-bearing facts (from BRIEF.md — do not re-derive)

- terax CSP `connect-src` already allows `http://localhost:*` / `http://127.0.0.1:*` → webview fetch/SSE to the daemon works without Rust changes.
- `terax <dir>` argv opens a directory as the workspace on all platforms; Spaces persist as unvalidated JSON (`terax-spaces.json`, `SpaceMeta {id,name,root,env,...}` + `state:<id>`).
- Module convention: self-contained `src/modules/<area>/` with `index.ts` barrels; tabs are mounted-but-hidden; command palette registers actions.
- No ACP/MCP upstream; PRs #193/#684 closed unmerged — nothing to wait for.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 repo-bootstrap | the fork exists, builds green, upstream wired | mechanical | new repo glance-desktop |
| 02 rebrand-lite | name/icon/identifier without conflict surface | mechanical | tauri.conf.json, package.json, icons |
| 03 rebase-protocol | dozens of upstream merges/week — drift discipline or death | mechanical | UPSTREAM.md, script/CI |
| 04 fleet-module-skeleton | connection settings, auth, health, empty pane registered | architectural | src/modules/fleet/ (new), tabs + palette registration |
| 05 roster-attention-panes | live fleet altitude: roster + attention queue over SSE | architectural | src/modules/fleet/ |
| 06 worktree-space-join | the core gesture, in-app: unit → Space | architectural | src/modules/fleet/, spaces store |
| 07 intervene-pane | why-stopped + diff + steer at webapp parity | architectural | src/modules/fleet/ |
| 08 bell-deeplinks | daemon attention → native notification → focused unit pane | mechanical | src/modules/fleet/, agents/notification plumbing |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | everything depends on the repo existing |
| 2 | 02, 03, 04 | disjoint; all touch only fork-local files |
| 3 | 05 | needs 04's connection layer |
| 4 | 06, 07, 08 | need 05's data layer; mutually disjoint panes |

## Working conventions for the loop

- Cockpit clone lives at `~/sui/glance-desktop` (created by C01). Branch-per-concern, PRs within glance-desktop repo, additive-only: new files under `src/modules/fleet/` plus the minimal registration touches upstream's module convention requires.
- Gates: `pnpm install && pnpm build`, `pnpm vitest run`, `cargo check` (full `cargo build` at least once per batch); Biome clean. Linux (WSL2) needs webkit2gtk/Tauri apt deps — C01 documents the exact set it installed.
- Gotcha (hit in C01): with an `upstream` remote present, bare `gh pr create` resolves the BASE repo to crynta/terax-ai and tries to open the PR upstream. `gh repo set-default lmvdz/glance-desktop` is set in the clone; still pass `--repo lmvdz/glance-desktop` explicitly in scripts.
- Daemon API additions belong in omp-squad PRs, never in the fork. The fork consumes the daemon's existing REST/SSE surface; when a gap is found, the loop files the daemon concern in this dir (new NN doc) and stacks accordingly.
