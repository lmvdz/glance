# Gate repo/.git mount → read-only (the operator-RCE vector)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/gate-runner.ts, src/proof.ts, src/worktree.ts, tests/gate-runner.test.ts, tests/gate-mount-readonly.test.ts (new)
MODE: afk

## Goal
An agent can no longer write anything the daemon or the operator later executes via the gate's bind mount. This
is a **live vector on main**, not hypothetical.

## Approach
`runGate` mounts the main repo — `.git` included — read-write into the gate container: `proof.ts:262`
passes `mounts: [opts.repo]`, and `gate-runner.ts:240` emits `-v ${dir}:${dir}` with **no `:ro`**. Agent-authored
gate code can therefore write `.git/hooks/*`, `.git/config` (`core.fsmonitor` / `core.sshCommand` / `core.pager`),
or — via the `worktree/node_modules → repo/node_modules` symlink (`worktree.ts:165-170`) — `node_modules/.bin/*`.
Hardened-git (`git-harden.ts:14-27`) neutralizes the daemon's own git, but **not the operator's**: the next time
a human runs plain `git status`/`git log` in that checkout, a planted `core.fsmonitor` executes as them.

Fix, per the containment contract (DESIGN.md):
- Mount the main repo `:ro` in the gate (`gate-runner.ts` mount construction).
- `repo/node_modules` reachable only `:ro`.
- If a gate stage genuinely needs a writable cache reachable through the worktree's `node_modules` symlink,
  give the container a private writable overlay/tmpfs at that cache path — never widen the shared-host mount.
- The worktree itself stays RW (the gate reads the agent's work there); only the shared `repo`/`.git`/
  `node_modules` go `:ro`.

Do NOT "fix git by mounting the repo RW" — `:ro` keeps the worktree's `.git` pointer resolvable while removing
write. That is the whole point.

## Cross-Repo Side Effects
None.

## Verify
- A pristine gate run (typecheck + suite) passes under the `:ro` mount — the acceptance bar; if a stage writes
  through `node_modules`, the tmpfs overlay covers it (prove which stage, don't guess).
- Mutation proof: a gate script that attempts to write `.git/hooks/post-checkout` (or `repo/node_modules/.bin/x`)
  fails with EROFS. Assert it.
- The existing `gate-runner.test.ts` mount assertions updated to expect `:ro` on repo/`.git`/`node_modules`.
