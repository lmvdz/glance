# Base-aware land gate in verifyMerged

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land.ts, tests/land-base-gate.test.ts, README.md

## Goal
Today `verifyMerged` (src/land.ts) resets main to `head0` on *any* non-zero merged gate, so a
target repo that is **already red at its base** can never land anything — the gate cannot tell
"the repo was already red" from "this branch broke it". Make the gate **base-aware**: only block
when the branch regressed a **green** base. A branch landing onto an already-red base lands, with
a logged note. Green-base behavior must stay byte-for-byte identical to today.

This is the worse-than-baseline pattern from `/research dxkit`, applied with the gate omp-squad
already runs — **zero new dependencies**. (The full rationale, the rejected dxkit-dependency
design, and every red-team concern's resolution are in `plans/netnew-land-gate/DESIGN.md` — read it
for context but do not re-open the decision.)

## Behavior (the only change is the last row)
| base @ head0 | merged main | action |
|---|---|---|
| no gate (`detectVerify` ⇒ undefined) | — | land (unchanged) |
| pass | pass | land (verified) — unchanged |
| pass | **fail** | reset → block (branch regressed) — unchanged |
| **fail** | **fail** | **land + log "landed onto a red baseline"** — was: block (the wedge) |

Note `fail`-base / `pass`-merged already lands today (merged gate passes) — no change needed there.

## Approach
In `landAgentLocked`, `verifyMerged` is the closure at ~src/land.ts:159-171, called from the
ff path (~:174) and the no-ff path (~:178). Keep the **hot path free**: run the base gate **only
when the merged gate fails** (the common green land still runs the gate exactly once).

Re-read src/land.ts before editing. Target shape:

```ts
// reMerge redoes the merge verifyMerged just checked, so we can re-land after a reset when the
// base was already red. ff path passes the ff merge; no-ff path passes the no-ff merge.
const verifyMerged = async (detail: string, reMerge: () => Promise<GitRun>): Promise<LandResult> => {
  if (!gate) return { ok: true, committed, merged: true, message, detail };
  const v = await runGate(gate, repo);
  if (v.code === 0) return { ok: true, committed, merged: true, message, detail: `${detail}; verified (${gate})` };
  // Merged gate failed — distinguish "branch regressed a green base" from "base was already red".
  await git(["reset", "--hard", head0], repo).catch(() => {});
  const base = await runGate(gate, repo); // main == head0 now
  if (base.code === 0) {
    // base was green ⇒ the branch introduced the failure ⇒ keep main green, block (unchanged).
    return { ok: false, committed, merged: false, message,
      detail: `merged ${branch} but verification failed (${gate}) — rolled main back to keep it green:\n${truncate(v.output, 800)}` };
  }
  // base was already red ⇒ main was never green; refusing would wedge every land on a brownfield
  // repo. Re-apply the merge and land, recording that we landed onto a red baseline.
  // ponytail: binary gate can't tell "still red" from "redder" — a branch that worsens an already
  // red base still lands. Upgrade path: per-framework failing-test diffing if that ever bites.
  const rm = await reMerge();
  if (rm.code !== 0) return { ok: false, committed, merged: false, message,
    detail: `base already red (${gate}); re-merging ${branch} failed: ${rm.stderr || rm.stdout}` };
  return { ok: true, committed, merged: true, message,
    detail: `${detail}; landed onto a red baseline — main was not green at head0 (${gate})` };
};

const ff = await git(["merge", "--ff-only", branch], repo);
if (ff.code === 0) return verifyMerged(`merged ${branch} (fast-forward)`, () => git(["merge", "--ff-only", branch], repo));

const merge = await git(["merge", "--no-ff", "-m", `Merge ${branch}: ${message}`, branch], repo);
if (merge.code === 0) return verifyMerged(`merged ${branch}`, () => git(["merge", "--no-ff", "-m", `Merge ${branch}: ${message}`, branch], repo));
```

After `reset --hard head0`, redoing `--ff-only` fast-forwards cleanly again; redoing `--no-ff`
recreates the merge commit. Both are deterministic on the serialized land.

## Cross-Repo Side Effects
None. `attemptAutoResolve`'s own gate (~src/land.ts:254, conflict path only) is **out of scope for
this unit** — leave it unchanged; a follow-up may apply the same base-aware logic there.

## Verify
`bun run check && bun run test` must pass. Add **tests/land-base-gate.test.ts** (mirror the existing
land/`git` test setup — see tests/land-ledger.test.ts and any land test in tests/squad.test.ts for
the temp-git-repo pattern; use real `git` in a tmp dir, no mocks). Cover all three rows with an
injected `verify` gate (e.g. a gate command that fails iff a marker file exists, toggled to make
base/merged red/green):
1. base green, branch clean → `ok:true`, detail contains `verified`.
2. base green, branch makes gate fail → `ok:false`, main reset to head0 (assert `git rev-parse HEAD` == head0).
3. base **already red**, branch clean → `ok:true`, detail contains `landed onto a red baseline`, and the branch's commit is present on main (`git log` contains it).

Update **README.md**: in the landing/verification section, document that a land onto an
already-red base now succeeds with a logged note instead of being refused (green-base behavior
unchanged). Ship the doc in this same branch.
