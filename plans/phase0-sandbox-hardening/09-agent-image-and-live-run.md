# Default agent image + credential injection + one live-proven omp-in-container run
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 06, 07, 08, voice-db-mode/02
TOUCHES: docker/agent.Dockerfile (new), src/sandbox-agent-driver.ts, src/agent-image.ts (new, mirror gate image build), tests/agent-image.test.ts (new)
MODE: afk

## Goal
There is a real, maintained image a sandboxed omp agent actually runs in, with credentials injected safely — and
it is proven end-to-end by one live run, not asserted. **This concern is the acceptance gate for all of 0b.**

## Approach
Today `SandboxConfig.image` is required with no default, no Dockerfile exists, `docker exec` passes no provider
credential, and real-omp-in-a-container has never been demonstrated (tests use a fake omp precisely to avoid
needing auth in the image). So the current opt-in sandbox can't actually run a real agent.

- **Default image + build story.** A `docker/agent.Dockerfile` (bun toolchain + omp + git), and an
  `agent-image.ts` that resolves/builds it with a version tag, mirroring the gate's `defaultGateImage()` /
  `DERIVED_SANDBOX_IMAGE` build (`gate-runner.ts:170-195`). A default-less sandbox spawn resolves to this image
  instead of failing.
- **Credential injection — never baked into the image.** Baking a key into a layer is worse at-rest handling
  than the env leak this whole plan closes; a plain `-e KEY=...` re-opens the spawn-env leak (visible to
  in-container `ps`/`docker inspect`). Inject per-spawn from the **org secret store** (`src/secrets.ts`, voice
  concern 02): the recommended mechanism is a **tmpfs-mounted credential file** the agent reads (invisible to
  `docker inspect`), sourced+decrypted at spawn from the store. (tmpfs-file vs exec-env is a MODE:hitl call —
  DESIGN.md — recommend the file.) Only the harness's own provider key is injected; no daemon secret.
- **The live run.** One real omp, in the container, completing a real unit end-to-end **including land** (the
  root-owned-write fix from 06 is what makes land work). This is the check that would catch the CSP-class
  "green tests, dead in production" surprise — the voice lane's lesson.

## Cross-Repo Side Effects
None (consumes `src/secrets.ts` from voice-db-mode/02).

## Verify
- Docker-gated: a default-less sandbox spawn resolves + builds the agent image; the image contains omp on PATH.
- Credential injection: the provider key reaches the agent via a tmpfs file; `docker inspect` and in-container
  `printenv` do NOT show it; no daemon secret (DATABASE_URL/BETTER_AUTH_SECRET) is present in the container.
- **Live acceptance run (scratch daemon, real key):** a real omp agent in the container reads a repo, makes a
  change, and the daemon lands it — recorded in this concern's Resolution with what was observed. A step that
  can't run states why. This gate is what flips 0b from "wired" to "proven."
