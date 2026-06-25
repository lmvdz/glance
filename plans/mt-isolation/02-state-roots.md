# State roots — per-tenant filesystem layout & org-scoped worktrees
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/worktree.ts, src/index.ts

## Decision

Per-org state lives under **`<root>/orgs/<orgId>/`**, where `root = OMP_SQUAD_STATE_DIR ||
~/.omp/squad` (the path computed today at index.ts `stateDirPath()` / squad-manager.ts:206).
File mode keeps **exactly** today's layout at `root` (no `orgs/` segment). The one path that is
*not* derived from `stateDir` today — the worktree base — must be made org-scoped too.

## Layout

```
<root>/                              # OMP_SQUAD_STATE_DIR || ~/.omp/squad
  daemon.lock                        # single root lock, ONE per daemon (05) — unchanged
  access-token                       # file mode only
  presence/  leases/                 # machine-wide registries (NOT per-org; see 06)
  orgs/
    <orgId-A>/
      state.json                     # this.stateFile (squad-manager.ts:207)  [file-mode store only]
      receipts/  digests/  workers/  # readReceipts/writeDigest (1213/1217), commission (865)
      worktrees/                     # org-scoped worktree base (was global)
        <repoBasename>-<branch>/
    <orgId-B>/ …
```

File mode (single implicit tenant) stays flat at `<root>/state.json`, `<root>/worktrees/…`, etc.

## What maps cleanly (just construct stateDir per org)

Everything that already derives from `this.stateDir` moves for free once the manager is
constructed with `stateDir = <root>/orgs/<orgId>`:
- `this.stateFile = path.join(this.stateDir, "state.json")` (squad-manager.ts:207)
- receipts: `appendReceipt(this.stateDir, …)` / `readReceipts(this.stateDir, …)` (1213, 1228)
- digests: `readDigest/writeDigest(this.stateDir, …)` (1071, 1216-1217, 1233)
- commission workers: `path.join(this.stateDir, "workers", spec.name)` (865)

No code change inside the manager for these — only the constructor's `stateDir` value differs,
which the registry (01) supplies. (In DB mode, `state.json` is replaced by `DbStore` — see 04;
receipts/digests/worktrees stay on disk under the org dir regardless.)

## What does NOT map — the worktree base (must thread)

`worktreeBase()` is **hardcoded** to `~/.omp/squad/worktrees` (worktree.ts:44-46), independent
of `stateDir`. The manager reaches it indirectly: `create()` calls
`resolveWorktree(opts.repo, branch)` (squad-manager.ts:723) → `addWorktree(...)` which computes
`opts.dir ?? path.join(worktreeBase(), \`${path.basename(repo)}-${safe}\`)` (worktree.ts:75).
So **two orgs working the same repo+branch collide on the same worktree path** — a hard
isolation break.

**Change:** make the base injectable, default preserving today's behavior.
- `worktree.ts`: add an optional `base` parameter where the default is `worktreeBase()`:
  - `addWorktree(opts: { …; base?: string })` → `const root = opts.base ?? worktreeBase();`
    `const dir = opts.dir ?? path.join(root, \`${path.basename(repo)}-${safe}\`)`.
  - `resolveWorktree(repo, branch, { base }?)` threads `base` into its `addWorktree` call.
  - `removeWorktree`/`listWorktrees`/`reapDeadWorktrees` operate on absolute worktree paths
    already (squad-manager.ts:1088, 1365-1398), so they need no base — but the manager's
    `reapDeadWorktrees` scan is naturally org-scoped because it only sees its own
    `this.agents` worktrees and its own repos. (Confirm: it iterates
    `[...this.agents.values()]` and `planeRepos()` only — squad-manager.ts:1368-1369.)
- `squad-manager.ts`: add `opts.worktreeBase?: string` to `SquadManagerOptions` (151) and a
  `private readonly worktreeBase` field defaulting to `worktree.ts`'s `worktreeBase()`. Pass it
  into the `resolveWorktree`/`addWorktree` calls in `create()` (723) and any worktree creation
  in `adoptOrphanedAgents`/`attachExisting` (332-334, 354).

`reconnectLive`/`adoptOrphanedAgents` reload persisted agents whose `worktree` is an absolute
path stored in `state.json`/roster row (squad-manager.ts:333 `existingPath: p.worktree`), so
restart reattaches to the right org-scoped worktree automatically — no path rewrite needed.

## File-mode coexistence

- `dbMode === false` (no `DATABASE_URL`): index.ts builds the single manager with
  `stateDir = root`, `worktreeBase = undefined` (→ defaults to today's `~/.omp/squad/worktrees`).
  **Zero behavior change** — same files, same paths, same tests.
- `dbMode === true`: the registry builds each manager with
  `stateDir = <root>/orgs/<orgId>`, `worktreeBase = <root>/orgs/<orgId>/worktrees`.

## Migration / pre-existing state

DB mode has not yet shipped a per-org runtime, so there is **no multi-org on-disk state to
migrate** — `orgs/<id>/` dirs are created lazily on first `manager.start()` (the manager already
`mkdir -p`s via `persistNow`/`fs.mkdir`; confirm `persistNow` and commission `fs.mkdir(dir,
{recursive:true})` at 866 — extend `persistNow` to ensure `this.stateDir` exists before write).
A self-host that ran DB mode against a *shared* root (P1) has its `state.json` at `<root>`; that
is the file-mode location, so it simply stays the file-mode single fleet — DB multi-org starts
greenfield. No migration tool (ponytail: document the path, don't build a migrator nobody needs).
If a future deploy must adopt a flat `<root>/state.json` into an org, it is a one-time
`mv <root>/state.json <root>/orgs/<orgId>/` — note in README, not code.

## Verify
- `tests` (extend worktree tests): `addWorktree({ repo, branch, base: tmpA })` and
  `{ base: tmpB }` for the same repo+branch produce paths under `tmpA` vs `tmpB` (no collision);
  `base` omitted falls back to `worktreeBase()` (file-mode parity).
- Construct two managers with distinct `stateDir`/`worktreeBase`; `create()` an agent in each;
  assert `state.json` (file-mode store) and the worktree dir land under the right org segment.

## Resolution

DONE — overview Plane tracking says OMPSQ-37/P2 landed, including OMPSQ-44. P3 OMPSQ-36 also landed, and the recorded gate passed: `bun run check` + `bun test` → 417 pass / 0 fail.
