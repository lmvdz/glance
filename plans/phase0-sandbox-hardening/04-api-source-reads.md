# Residual API source-read holes
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts, src/squad-manager.ts, tests/api-source-reads.test.ts (new), tests/ws-org-isolation.test.ts
MODE: afk

## Goal
An authenticated viewer cannot read the operator's — or another org's — source code or host paths through the
API. These are the residual cross-tenant reads (the PR #152 class, half-closed).

## Approach
Three holes, all cited:
1. **`resolveGraphRepo` allows `process.cwd()`** (`server.ts:2701-2707`): the allowlist includes the daemon's own
   cwd and a no-`?repo` request defaults to it, so any authenticated **viewer** can `GET /api/graph/commit?repo=
   <daemon cwd>` and read the operator's source diffs. Fix: drop the `process.cwd()` default and membership;
   require the request to name a repo the caller's org/role actually owns (scope to `manager.projects()` for that
   actor, never the daemon's cwd).
2. **`/api/info` returns `{cwd: process.cwd()}`** at the no-active-org tier (`server.ts:873`, inside `noFleet()`).
   Drop the `cwd` field — an org-less viewer has no legitimate use for the daemon's filesystem path (mirror the
   admin-gated cwd in `/api/doctor`).
3. **`registerProject` accepts any absolute host git path** (`squad-manager.ts:2404-2444`), guarded only against
   the state dir. Any other host repo is registerable → widens the graph allowlist → cross-repo/cross-tenant
   source read. Fix: require admin role for the registering org, and/or restrict to an operator-configured
   projects-root allowlist set at boot ("the daemon only manages repos under `~/code`").

## Cross-Repo Side Effects
None.

## Verify
- New test: a viewer `GET /api/graph/commit?repo=<daemon cwd>` → refused (not the old source diff); a viewer with
  no repo param → no cwd default leak.
- `/api/info` at the org-less tier no longer contains `cwd`.
- `registerProject` with an arbitrary host path outside the allowed root → refused; inside → allowed.
- **This is the cross-tenant class the memory flags cross-lineage review has caught before — run `/code-review`
  high + a foreign lineage on this diff specifically**, even though it's small.
