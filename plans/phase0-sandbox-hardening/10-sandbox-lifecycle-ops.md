# Sandbox lifecycle operational hardening — leases, orphan reaper, capacity metrics
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 06
TOUCHES: src/agent-driver.ts, src/lease-hook.ts, src/squad-manager.ts, src/sandbox-agent-driver.ts, tests/sandbox-lease.test.ts (new)
MODE: afk

## Goal
Sandboxed units don't strand leases, don't leak containers across a crash, and their footprint is measurable
before Phase 3 decides whether to flip the default.

## Approach
Three operational gaps, all independent:
1. **Stranded leases (F9).** `AgentDriver.pid` is undefined for sandbox drivers (`agent-driver.ts:37-42`), and
   lease release is keyed `omp:<pid>` from the child's own pid — inside a pid namespace that's a namespaced pid
   the manager can never match, so dead sandboxed agents strand leases. Make lease release **driver-aware**: key
   on the agent id (not the child pid) for pid-less drivers.
2. **Orphan container reaper (F12).** A daemon crash leaves `omp-sbx-*` containers running `sleep infinity` with
   no reaper (the manager's own comment flags the class — `squad-manager.ts:4615`, OMPSQ-163/146). On daemon
   boot, `docker ps -a --filter name=omp-sbx-` reconciled against the live roster; `rm -f` what the roster
   doesn't own. Harmless at today's opt-in scale, host-eating at default-on — ship it before Phase 3.
3. **Capacity instrumentation (F5/F6).** `hardAgentCeiling` counts *agents*, not containers, and this WSL2 host
   has vhdx-exhaustion history. Record per-unit container count + per-container disk/memory watermark under the
   existing `learningMetrics` channel. This is the "instrument before flipping" gauge Phase 3 reads to set the
   default resource limits and per-host container budget — without it, "measure before flipping" is a sentence,
   not a number.

## Cross-Repo Side Effects
None.

## Verify
- A killed sandboxed agent releases its leases (mutation-proven: pid-keyed release strands it, id-keyed doesn't).
- Boot with a stray `omp-sbx-<dead-id>` container present → reaper removes it; a live-roster container survives.
- Metrics record container count + a disk/memory watermark for a sandboxed run (assert a record lands).
