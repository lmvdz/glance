# Route validate.ts's spawns through the shipped gate container
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/validate.ts, src/gate-runner.ts, tests/validate.test.ts

## Goal
The commissioning gate (`validateWorker`) — the last executor of agent-authored code that runs unsandboxed on the daemon host — executes inside the same fail-closed docker harness every other gate already uses. Closes scout ticket OMPSQ-160.

## Approach
- Ground truth: `src/gate-runner.ts` is the shipped, default-on containerized gate primitive (`gateExec`/`execGatedCommand`) — scrubbed env, `--network none` default, worktree mounts, non-root uid, degraded-image + unrunnable classifiers, STRICT mode, and it already owns `OMP_SQUAD_GATE_SANDBOX` (`image | host/off | unset=auto`). Every verify/proof/land gate routes through it; only `src/validate.ts`'s `Bun.spawn` calls (typecheckWorker :87, acceptanceWorker :162, lint) do not — the file's own comment at :158-161 names the upgrade path. **Do not build a new primitive** (red-team, both: a second docker path forks security plumbing that will drift and would re-declare an env var that already means something else).
- Route each `Bun.spawn` in validate.ts through `execGatedCommand`, preserving `acceptanceEnv`/`baselineEnv` scrubbing as belt-and-suspenders inside the container.
- The acceptance decision (red-team S3): `flue run` acceptance makes real model/network calls (validate.ts:104-108 ships CA-cert env vars for exactly this), and gate containers default to `--network none`. Resolution: a per-call network override on `execGatedCommand` (add if absent — check `OMP_SQUAD_GATE_SANDBOX_NETWORK` plumbing first) used ONLY by the acceptance worker, defaulting to the gate-wide setting for lint/typecheck. This is a scoped, documented widening for one gate — never a global network default change. If a per-call override contradicts gate-runner's design, the fallback is: acceptance keeps host execution behind an explicit `OMP_SQUAD_ACCEPTANCE_HOST=1` escape with a loud warning, and lint/typecheck containerize unconditionally — partial containment honestly labeled beats false-green.
- No shadow host-vs-container diff mode (red-team: zero security during shadow + model nondeterminism makes the diff noise; the shipped gate sandbox went default-on with unrunnable/degraded classifiers instead — follow that precedent).
- Close OMPSQ-160 with a pointer to this concern when it lands.

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/validate.test.ts` — existing suite green; new case asserting the spawn path goes through gate-runner when docker is available (inject a fake runner).
- Live: run a commissioning validate on a scratch worker with docker up — gate logs show container execution for lint/typecheck; acceptance runs with its documented network posture. Kill docker → STRICT semantics match the rest of the gate system (degrade or refuse per existing contract, verified against `gateRunUnrunnable`).

## Resolution
Shipped on branch worktree-research-adw-software-factory (PR #183), merged as 7c8c675 with integration/audit follow-ups on the same branch (see EXECUTION-LOG.md). typecheck+acceptance spawns routed through execGatedCommand (closes OMPSQ-160; lint has no spawn — concern anchor was wrong); post-review hardening: argv-direct hostArgv fallback (login shell re-imported profile secrets, code-review [0]) and acceptance network honors an explicit operator OMP_SQUAD_GATE_SANDBOX_NETWORK (code-review [1]).
