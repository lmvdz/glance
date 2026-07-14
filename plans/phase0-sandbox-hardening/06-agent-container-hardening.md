# Harden the agent container (SandboxAgentDriver)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/sandbox-agent-driver.ts, src/gate-runner.ts (reuse sandboxUser/plan shape), tests/sandbox.test.ts, tests/sandbox-hardening.test.ts (new)
MODE: afk

## Goal
The opt-in `--sandbox` container is a real boundary and its worktree writes are landable — today it runs as root
with full network egress, no resource limits, and no mount discipline.

## Approach
`SandboxAgentDriver.start()` (`sandbox-agent-driver.ts:86-148`) builds `docker run -d --name … -w <workdir>` +
(if mount) `-v <worktree>:<workdir>` **read-write** + verbatim `runArgs` + `<image> sleep infinity`. It sets
none of the hardening the gate already proved (`gate-runner.ts:213-257` `sandboxPlan`/`sandboxUser`). Port and
extend:

- **`--user <uid:gid>` + `HOME=/tmp`** (from `sandboxUser`, `gate-runner.ts:213-226`). Fixes the root-owned-write
  vector: the daemon's host-side land/commit (the #150 interlock — daemon commits, agents never) currently dies
  on EACCES + git dubious-ownership on root-touched files, making every sandboxed unit un-landable (the PR #30
  incident, re-encountered).
- **Mount discipline (containment contract, DESIGN.md):** worktree `:rw`; `repo/.git` and `repo/node_modules`
  `:ro`; build caches to a container-private `--tmpfs`; nothing else from the host. `--user` is file-ownership
  hygiene, NOT the boundary — the boundary is the mounts + caps below.
- **Resource limits + caps:** `--pids-limit`, `--memory`, `--cpus`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, `--read-only` rootfs with explicit writable tmpfs. Bounds the fork-bomb /
  disk-fill DoS that today takes down the host and every tenant.
- **`--network none` by default** (today requires manual `runArgs`), with an explicit opt-out flag. Egress
  allowlist proxy stays deferred to Phase 3.
- **Availability ladder + container-aware failure diagnosis:** port the gate's auto/strict semantics
  (`gate-runner.ts:~200`); an *explicitly sandboxed* unit gets STRICT only — docker-absent is a hard refusal,
  never a host fallback (see concern 07). Add a diagnoser distinguishing image-absent / daemon-down /
  omp-not-on-PATH (today all surface as one opaque `docker run failed` string).

Default resource-limit values are a MODE:hitl question (DESIGN.md) — parameterize, don't hardcode a guess.

## Cross-Repo Side Effects
None (consumes concern 01's `:ro` mount contract).

## Verify
- Docker-gated test (skip without docker, mirroring `sandbox.test.ts`): the `docker run` argv contains `--user`,
  `--network none`, `--pids-limit`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `:ro` on
  `.git`/`node_modules`. A regression here is the silent-drift class — assert each flag.
- A sandboxed unit's worktree is owned by the daemon uid after a run → host-side `git commit` succeeds (the
  land path that's broken today).
- In-container write to `.git` / a `--memory` overrun / a fork bomb are contained (EROFS / OOM-kill /
  pids-limit), not host-fatal.
