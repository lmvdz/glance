# Sandbox spawn policy — inheritance, no silent downgrade, strict gates, honest rejection
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 06
TOUCHES: src/squad-manager.ts, tests/sandbox-inheritance.test.ts (new), tests/sandbox-restore.test.ts (new)
MODE: afk

## Goal
Once a unit is sandboxed, it stays sandboxed — across its children, its gates, and a daemon restart — or it
refuses to run. No path silently un-sandboxes a unit that was meant to be contained.

## Approach
Four holes in `squad-manager.ts`, keyed on the **existing `sandbox` field** (the `untrusted` trust flag is
Phase 3 — a dead flag now; this ships the plumbing it will later re-derive into):

1. **Inheritance on fan-out (C1).** `spawnFleetBranch` (`~4854`) builds children via `createInternal` with no
   `sandbox` passthrough → a sandboxed parent fans out unsandboxed host children with full env. Propagate the
   parent's `sandbox` config through every child-construction path (createInternal, commission, fan-out branch).
   Invariant test: a child of a sandboxed parent is itself sandboxed.
2. **No silent downgrade (C2).** For an explicit or inherited sandbox unit, docker-absent at (re)spawn is a
   **hard refusal** (mark the unit errored/held), never a host fallback — and **non-overridable** by any env var.
   The failure mode to kill: docker present at create, gone at respawn, unit silently downgrades to unconfined.
3. **Sandboxed unit ⇒ STRICT gates.** A host-fallback gate run on a sandboxed agent's worktree executes
   agent-authored code as the daemon (the containment-contract daemon vector). If the unit is sandboxed, its
   gates run STRICT (concern 06's ladder), fail-closed.
4. **Loud rejection for sandbox × workflow and × non-omp.** Today `makeDriver` dispatches `kind:"workflow"`
   before reading `p.sandbox` (`~4667` vs `~4710`), so a workflow unit silently ignores sandbox; and `create()`
   already rejects sandbox × non-omp (`~4348`). Extend the explicit rejection to the workflow case until Phase 3
   — never silently un-sandbox.
5. **Restore parity (M1).** Add an invariant test that the restore/adopt rebuild sites (`~1612`, `~8420`,
   `~4452`) reconstruct a SandboxAgentDriver, and that inherited-sandbox children survive a daemon restart.
   Re-derive the driver from `p.sandbox` at `makeDriver` so a record whose field somehow cleared still cannot
   respawn unconfined.

## Cross-Repo Side Effects
None.

## Verify
- Inheritance: fan-out from a sandboxed parent → all children sandboxed (mutation-proven: remove the passthrough
  → the invariant test goes red).
- Downgrade refusal: simulate docker-absent-at-respawn for a sandboxed unit → held/errored, NOT a host run; and
  an env var cannot override it.
- A sandboxed unit's gate runs STRICT (no host fallback observed).
- `sandbox` + `workflow` → loud rejection, not a silent host workflow.
- Restore/adopt of a sandboxed record → SandboxAgentDriver; children survive restart still sandboxed.
