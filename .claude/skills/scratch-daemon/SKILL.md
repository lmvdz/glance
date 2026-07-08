---
name: scratch-daemon
description: Boot an isolated throwaway glance daemon (own state dir + port) to verify daemon/webapp changes live without touching the operator's fleet — including the detach pattern that works, seeding real data, agent-browser/SSR verification, and teardown. Use for /verify choreography, smoke-testing a new endpoint, dogfooding the pipeline in a controlled run, or post-merge production-truth checks.
---

# scratch-daemon — live verification without touching the fleet

Re-derived painfully in at least six sessions (~10 spinups in one of them, 3 distinct spawn-failure modes). This is the choreography that works.

## Boot

```bash
export OMP_SQUAD_STATE_DIR=$(mktemp -d /tmp/glance-scratch-XXXX)   # own state dir — the live daemon holds a lock on the real one
export PORT=0                                                       # or pick a free port; never 7878 (live)
export PATH="$PWD/node_modules/.bin:$PATH"                          # else `omp` isn't found
# SAFETY (non-negotiable for scratch boots): loops OFF, or the scratch daemon will pull the REAL
# Plane backlog and claim live tickets — this happened THREE times on 2026-07-08 (scratch daemons
# claimed OMPSQ-422/423/425 and probe tickets). Plane secrets are ambient on this host.
export OMP_SQUAD_AUTODISPATCH=0 OMP_SQUAD_AUTODRIVE=0 OMP_SQUAD_AUTOLAND=0
export OMP_SQUAD_AUTOSUPERVISE=0 OMP_SQUAD_AUTO_SUPERVISE=0 OMP_SQUAD_LAND_CONFIRM=1
# unset alone is NOT enough: the daemon unconditionally loads ~/.claude/secrets/plane.env at boot
# (proven live 2026-07-08). Repoint HOME at an empty dir so no secrets file is readable:
export HOME=$(mktemp -d /tmp/glance-scratch-home-XXXX)
unset PLANE_API_KEY PLANE_API_TOKEN 2>/dev/null || true             # belt-and-suspenders on top
nohup bun src/index.ts serve > "$OMP_SQUAD_STATE_DIR/daemon.log" 2>&1 &
```

- **Detach pattern**: separate `export` lines + plain `nohup … &`. NOT `run_in_background` (SIGTERMs the child when the tool returns), NOT compound `cd X && VAR=y nohup …` chains (first non-zero step silently kills the rest — a build timeout once left a merge unstaged this way).
- **Sockets gotcha**: two daemons sharing `~/.omp/squad/sockets` SIGTERM-reap each other's agents within ~5s. The scratch state dir must isolate the socket dir too.
- Webapp: `bun run build` first if verifying UI; the daemon serves `webapp/dist`.
- Auth: file mode token is at `<stateDir>/access-token`; probe `GET /api/auth/mode` to confirm mode; db-mode needs cookie sessions.

## Seed and drive

- Seed reversible data: copy live receipts into the scratch state dir when real data is needed (remap absolute `repo` paths inside the copied docs — they point at the original checkout), or file a throwaway plan dir / `stageOverride` PATCH.
- Drive the UI with agent-browser (`AGENT_BROWSER_SOCKET_DIR` must be a short path; synthetic-click "nothing happened" can be a false negative — confirm against source before declaring a bug). Screenshot to **absolute paths** (relative paths litter the repo root).
- Component-level rendering without a daemon: SSR the component with real receipt data, bundle as **IIFE** (ESM breaks over `file://`), external script tag (inline `</script>` in data breaks the page), headless chromium screenshot. Look at it before shipping — "I iterated blind three times" is the mined anti-pattern.
- Single-endpoint smoke: curl the new route with the on-disk token, assert the JSON shape. That's the whole test — don't boot the webapp for it.

## Controlled pipeline dogfood (the factory variant)

Fresh state dir blocks stale-agent adoption. Then: `OMP_SQUAD_AUTODISPATCH=0`, `OMP_SQUAD_LAND_CONFIRM=1`, BOTH supervisors off (`OMP_SQUAD_AUTOSUPERVISE` **and** `OMP_SQUAD_AUTO_SUPERVISE` — the lookalike pair; one silently auto-approves human gates). Spawn the unit with `--approval yolo` (default `write` stalls the run on read-only scout spawns). Watch gates via the API: answers must go to `POST /api/command {type:"answer", id, requestId, value}` — typing "Approve" in chat does nothing. If a gate stops responding, check `lastActivity`: a dead-at-gate process needs a restart before the answer can land.

## Teardown

Kill **by port/pid recorded at boot**, never `pkill -f` by name (has matched the session's own shell). `rm -rf` the scratch state dir. If you copied receipts, nothing to revert — that's the point.

## Prove-preexisting (companion micro-protocol)

When the gate/suite fails after your change: run the identical suite at the base SHA, diff the failure sets, own only the delta. This repo has 2 stable WSL spawn flakes (PATH-dependent); pin the session's known-flake set once and diff against it on every later run instead of re-litigating.
