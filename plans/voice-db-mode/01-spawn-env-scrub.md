# Spawn-env scrub — tenant agents must not inherit the daemon's secrets
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/agent-host.ts, src/omp-call.ts, src/acp-agent-driver.ts, src/gate-env.ts (extract shared scrub), src/spawn-env.ts (new), tests/spawn-env.test.ts (new), tests/gate-env.test.ts
  Fix round 2 (review findings, inside this concern's Goal per adjudication): src/worktree.ts,
  src/squad-manager.ts (bun-install provisioning spawns also scrubbed — a hostile tenant repo's root
  postinstall runs under them too); src/land.ts, src/vision.ts, src/flue-service-driver.ts
  (harnessAuthEnv narrowed per-spawn instead of admitting every configured provider credential); src/
  model-lineage.ts (resolveProvider reused, no changes needed there)

## Goal
No secret in the daemon's environment reaches a tenant agent's process. Today every agent spawn inherits the
daemon's full env — so `DATABASE_URL` (and, once this plan lands, the voice boot secret) is readable by any
agent via `printenv` or hostile repo content that induces it. This is a **live multi-tenant hole today**,
independent of voice: it ships first and stands alone.

## Approach
`src/gate-env.ts` already has the right discipline for gate containers (it strips `OMP_SQUAD_*`/`GLANCE_*`
because agent-authored code once exfiltrated "every LLM provider credential"). Extract that into a shared
`scrubbedSpawnEnv(base)` in a new `src/spawn-env.ts` and route **all three** agent spawn sites through it:

- `src/agent-host.ts` — spawns with `env: { ...process.env, ... }` (full inheritance).
- `src/omp-call.ts` — same shape.
- `src/acp-agent-driver.ts` — passes **no `env` option at all**, which inherits everything implicitly. It must be
  given an explicit scrubbed env; this is the easiest site to miss.

Scrub list (deny-by-shape, not an allowlist of known-bad — new secrets must be safe by default):
- Every `OMP_SQUAD_*` and `GLANCE_*` var (env-compat mirrors the two prefixes, so a scrub of one alone is a hole).
- `DATABASE_URL`, `BETTER_AUTH_*`, `GITHUB_*`, `WORKOS_*`, `PLANE_*`, and any name matching a secret shape
  (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIALS`).
- Keep what an agent legitimately needs: `PATH`, `HOME`, `SHELL`, `LANG`/`LC_*`, `TERM`, `TZ`, plus the explicit
  per-agent vars each driver already sets (model/thinking/approval), and the harness's own auth vars — an agent
  harness needs its provider credential to function, so the deny-list must NOT strip the harness's own key. Name
  that allowance explicitly and keep it narrow (the harness key for *this* spawn, injected deliberately).

Do not silently drop a var an agent needs — a scrub that breaks spawns will be reverted, and then nothing is
scrubbed. The test suite is the proof that both halves hold.

## Cross-Repo Side Effects
None.

## Verify
- Unit: `scrubbedSpawnEnv` strips both prefix twins, `DATABASE_URL`, and each secret-shape pattern; preserves the
  keep-list; and preserves a deliberately-injected harness key.
- Mutation proof: delete the `acp-agent-driver` scrub → a test asserting the spawned ACP env lacks `DATABASE_URL`
  must go red (it is the site that inherits *implicitly*, so a naive "it has no env option, so nothing leaks"
  reading is exactly the bug).
- Live: spawn a real agent (scratch daemon) whose task is `printenv | sort`, and assert the transcript contains
  no `DATABASE_URL`, no `*_SECRET`, no `*_KEY` other than the harness's own. This is the only check that proves
  the whole chain; fakes cannot.
  **RUN 2026-07-14** (fix round 2, after two prior deferrals): isolated scratch daemon (own state dir, port
  18790, autodispatch/autodrive/autoland/autosupervise OFF), `glance add <throwaway repo> --task 'printenv |
  sort, paste verbatim' --approval yolo --plain`. Traversed the real chain end to end — squad-manager →
  `resolveHarness`/`makeDriver` → `RpcAgent.spawnHost` → `agent-host-main.ts` → `runAgentHost` →
  `scrubbedSpawnEnv`+`harnessAuthEnv` — confirmed via `ps` (daemon pid → `agent-host-main.ts --harness omp`
  pid → the spawned `omp --mode rpc` pid). Agent completed the task and reported its own env (61 vars) back
  in the transcript; parsed every `KEY=VALUE` line programmatically against the same deny classes
  (`OMP_SQUAD_*`/`GLANCE_*`, `DATABASE_URL`, `BETTER_AUTH_*`/`GITHUB_*`/`WORKOS_*`/`PLANE_*`,
  `*_KEY|*_SECRET|*_TOKEN|*_PASSWORD|*_CREDENTIALS?`) — zero violations. No `ANTHROPIC_API_KEY` was present
  in the daemon's own env at boot, so `harnessAuthEnv` had nothing to (correctly) inject; the keep-list/
  behavior-control vars (`PATH`, `HOME`, `PI_RPC_EMIT_TITLE`, etc.) and omp's own tool-sandbox vars
  (`GIT_PAGER`, `CI`, …) were the only things present. Scratch daemon + worktree + throwaway repo torn down
  after capture; the live production daemon (port 7878, db mode) was never touched.
- Full suite + both typechecks green (spawn tests are PATH-sensitive — run with `node_modules/.bin` on PATH).
