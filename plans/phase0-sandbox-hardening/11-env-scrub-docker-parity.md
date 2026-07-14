# Env-scrub docker-boundary parity
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: voice-db-mode/01
TOUCHES: src/sandbox-agent-driver.ts, tests/spawn-env-docker-parity.test.ts (new)
MODE: afk

## Goal
No daemon secret crosses the container boundary via `docker run -e` / `docker exec -e`. This is the ONE thing
Phase 0 adds to the env-scrub — the scrub itself is done on `worktree-voice-db-mode` (concern 01) and must not
be re-implemented here.

## Approach
`src/spawn-env.ts` (voice concern 01, STATUS:done on the voice branch) routes agent-host/omp-call/
acp-agent-driver through a shared scrub with a harness-key keep-list. The sandbox driver's `docker exec` already
passes only an explicit `-e` allowlist (`sandbox-agent-driver.ts:98-99`), and `docker run` passes none — so the
container path is *already* the tightest. This concern **verifies and pins** that:

- Reconcile the sandbox driver's `-e` allowlist against the `spawn-env.ts` keep-list (single source of truth for
  "what an agent legitimately needs"), so the two can't drift.
- Add an invariant test asserting no secret-shaped daemon var (DATABASE_URL, BETTER_AUTH_SECRET, *_KEY, *_SECRET,
  *_TOKEN, both `GLANCE_*`/`OMP_SQUAD_*` twins) appears in the composed `docker run`/`docker exec` argv — only
  the deliberately-injected harness key (from concern 09) and the benign non-secrets.

If the voice branch stalls, this concern's dependency is satisfied by cherry-picking concern 01 — never by
forking the scrub.

## Cross-Repo Side Effects
None.

## Verify
- Parity test: the sandbox driver's `-e` set ⊆ `spawn-env.ts` keep-list ∪ {injected harness key}; no daemon
  secret present. Mutation-proven: add `DATABASE_URL` to the `-e` list → the test goes red.
- The keep-list is imported from `spawn-env.ts`, not duplicated (grep: no second copy of the allowlist).
