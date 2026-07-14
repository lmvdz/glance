# Design: Phase 0 — Agent Sandbox & Secret Hardening (re-cut)

Adversarial design panel, 2026-07-14 (designer → 2 red teams → arbiter). Every load-bearing claim below is
code-verified on `main` @ 9a3aefc (and the `worktree-voice-db-mode` branch). This is the security foundation of
the single-tenant + marketplace strategy (`docs/security/enterprise-strategy.md`).

## Scope decision — the flip verdict

**The default-sandbox flip is deferred to Phase 3.** Three independently sufficient, code-verified reasons:

1. **Architecturally unreachable today.** `routeIntake` runs only when `!opts.sandbox` (`squad-manager.ts:4252`),
   so stamping sandbox by default silently kills verify/land routing; and `makeDriver` dispatches on
   `kind:"workflow"` *before* reading `p.sandbox` (`~4667` vs `~4710`), so a routed unit ignores sandbox
   entirely — its inner coder/tester are hardcoded `new RpcAgent` (`workflow-driver.ts:513,533`). `create()`
   hard-rejects sandbox for every non-omp harness (`~4348`) → the flip breaks pi/claude-code/codex/gemini/grok
   (#147, merged 2026-07-13). The code's own comments assign protocol-aware containment to Phase 3, twice.
2. **Nothing to flip to.** `SandboxConfig.image` is required, no Dockerfile exists in the repo, and real
   omp-in-a-container auth is unproven (tests inject a fake omp precisely to avoid needing tokens in the image);
   `docker exec` passes no provider credential.
3. **The container does not currently contain** (see the containment contract). Flipping now would ship a false
   security claim at fleet scale — worse than no claim.

**Phase 0 = 0a (mechanical hygiene, ships now, zero sandbox dependency) + 0b (harden the opt-in sandbox until
"sandboxed" is a true statement).** Phase 0 does NOT include: the default flip, the `untrusted` trust field, a
protocol-agnostic containment wrapper, an egress proxy, or WorkflowDriver inner-agent containment — all Phase 3.

## The containment contract (the deepest finding — confirmed against today's code, not the hypothetical flip)

**The unit of trust is the worktree, not the container.** Anything an agent writes that the daemon or the
operator later *executes* is an escape, regardless of container isolation. Two live vectors exist now:

- **Daemon vector:** `worktree.ts:165-170` symlinks `worktree/node_modules → repo/node_modules`. An agent
  writing `worktree/node_modules/.bin/tsc` writes the shared install; the daemon's next host-side `bun run
  check` executes it as the daemon. No `.git`, no fallback needed.
- **Operator vector:** the gate mounts the main repo `.git` **read-write** (`proof.ts:262` → `gate-runner.ts:240`,
  no `:ro`). Agent gate code writes `.git/hooks/*` or `core.fsmonitor` → runs as **you** on your next plain
  `git status`. Hardened-git (`git-harden.ts:14-27`) shields the daemon's own git, never the human's.

v1 contract (invariants): inside any container, worktree mounted RW; `repo/.git` and `repo/node_modules` mounted
`:ro` (git needs `.git` readable for the worktree pointer — `:ro` answers "how does git work," not "refuse the
mount"); build caches get a container-private tmpfs/overlay, never the shared host dir. The daemon never executes
worktree-resolved binaries outside a gate container, and **gates for sandboxed units run STRICT** (no host
fallback, since a host-fallback gate executes agent code as the daemon). For *unsandboxed* units (today's
default) the daemon-side symlink vector remains — **named as accepted residual risk**, and precisely what
Phase 3's flip closes; pretending 0b eliminates it would repeat the false-green pattern.

## Dependencies on voice-db-mode (de-duplicated)

- **Env-scrub is a dependency, not a work item.** `src/spawn-env.ts` + tests exist on `worktree-voice-db-mode`
  (concern 01, done), routing agent-host/omp-call/acp-agent-driver through a shared scrub with a harness-key
  keep-list. Phase 0 adds exactly one thing: a **docker-boundary parity test** (no daemon secret crosses
  `docker run -e`/`docker exec -e`). One owner per file.
- **At-rest encryption is consumed, not deferred.** Voice concern 02 (p0, open) builds the AES-256-GCM per-org
  secret store (`src/secrets.ts`). 0b's container credential injection reads from it; 0a's secret hygiene covers
  only what 02 doesn't (file perms, redaction, gate logs, API holes). The draft's "defer at-rest crypto" is
  overruled — it contradicted a live sibling p0.

## Key decisions

| # | Decision | Verdict | Evidence |
|---|---|---|---|
| 1 | Default-sandbox flip in Phase 0? | **No — Phase 3** | squad-manager.ts:4252/4346/4348/~4710; workflow-driver.ts:513,533; no Dockerfile |
| 2 | Phase 0 shape | 0a mechanical + 0b opt-in parity | red-team scope verdict |
| 3 | Containment unit | The worktree; `.git`/`node_modules` `:ro`, private overlay for builds | worktree.ts:165-170; proof.ts:262; gate-runner.ts:240 |
| 4 | Gate repo mount | `:ro` immediately (0a) — live operator-RCE vector | git-harden protects daemon only |
| 5 | Trust taint | `untrusted` flag deferred (dead flag); sandbox-inheritance + hard-refusal ship now on the existing `sandbox` field | F7 + C1/C2 |
| 6 | Env-scrub | Dependency on voice concern 01; add only docker-boundary parity | spawn-env.ts on voice branch |
| 7 | At-rest encryption | Delegated to voice concern 02; Phase 0 consumes it | plans/voice-db-mode/02 |
| 8 | Sandboxed unit's gates | STRICT only, fail closed | host-fallback gate = daemon executes agent code |
| 9 | Credentials into containers | Per-spawn injection from org secret store; never baked into image | no-image finding |
| 10 | sandbox × workflow / × non-omp | Loud rejection until Phase 3 | mirror of ~4348 |

## Risks

- **`:ro` mounts break gate builds** if a stage writes through `node_modules` (postinstall, caches). Mitigation:
  tmpfs overlay for cache paths; acceptance = a pristine gate run under the new mounts before merge.
- **Unsandboxed default remains the fleet reality through Phase 0** — the daemon-side symlink vector persists for
  host agents. Honestly-named residual that justifies Phase 3, not a gap here.
- **Voice-branch coupling:** if `worktree-voice-db-mode` stalls, 0b credential injection loses its substrate;
  fallback is cherry-pick 01/02, never fork the scrub.
- **STRICT gates for sandboxed units reduce availability** on docker hiccups — the designed trade (fail closed
  beats execute-agent-code-as-daemon); needs legible diagnostics.
- **Real-omp-in-container auth is unproven** until 0b's live run; budget for the "works until it doesn't" class
  the voice CSP blocker was.

## Open questions (MODE: hitl — preference calls, resolve before/at 0b execution)

1. Operator-side git protection: a shell wrapper / per-worktree `extensions.worktreeConfig` hardening so *your
   own* `git status` in an agent worktree is neutralized, or is `:ro`-in-containers + docs enough?
2. Default resource-limit values (`--memory`/`--cpus`/`--pids-limit`) — depends on concurrent-sandboxed-unit
   intent on this WSL2 host; informed by 0b instrumentation.
3. Credential-injection mechanism: tmpfs file mount (invisible to `docker inspect`) vs exec-time env (simpler,
   visible to in-container `ps`). Recommend the file mount.
