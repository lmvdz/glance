# PR reconciler backstop

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, tests/pr-reconciler.test.ts (new)

## Goal

Because `gh pr merge` inside `landAgentPr` (concern 06) is synchronous, this loop is a BACKSTOP for the one case the synchronous path cannot see: a human merging (or closing) the PR directly in the GitHub UI, out of band from the daemon. It also absorbs the crash-ordering cases the synchronous path can leave stranded (daemon dies between push and `gh pr create`; between merge and DoneProof write; between DoneProof write and Plane close). It is a small always-on manager loop — like the existing plan-sync timer — NOT gated by `OMP_SQUAD_OBSERVE` (Observer is operator-toggleable; a toggleable "self-audit" must not silently stop Done-writes for merged PRs), and it runs in DB mode too (unlike Observer/plan-sync, which are file-mode-repo-scoped today — verify at implementation time whether this loop needs its own repo-iteration source in DB mode, or can share whatever repo-list DB mode already threads through).

**Imports consumed from concern 06** (`src/land-pr.ts`): `listPendingPrs`, `updatePendingPr`, `ensurePr`. **From concern 01** (`src/done-proof.ts`): `recordDoneProof`. **From concern 05** (`src/gh.ts`): `ghJson`.

## Approach

### 1. Timer wiring — mirror the plan-sync pattern

Verified pattern to mirror, `src/squad-manager.ts:581-601` (the `OMP_SQUAD_PLANSYNC` block):

```ts
if (process.env.OMP_SQUAD_PLANSYNC !== "0" && observeRepos.length > 0) {
	const intervalMs = Number(process.env.OMP_SQUAD_PLANSYNC_INTERVAL_MS) || 300_000;
	for (const repo of observeRepos) {
		const tick = (): void => { void syncPlanStatuses({ ... }).then(...).catch(() => {}); };
		this.planSyncTimers.push(setInterval(tick, intervalMs));
		setTimeout(tick, 15_000);
	}
}
```

Add a new block (unconditional — no `OMP_SQUAD_OBSERVE` or `OMP_SQUAD_PLANSYNC` guard; this loop's own activity gate is "does the ledger have any open entries", checked inside the tick, not an env flag):

```ts
const prReconcileTick = async (): Promise<void> => {
	const ledgers = new Map<string, PendingPr[]>(); // repo path -> its open entries; reconstruct per-repo stateDir scoping the same way listPendingPrs is scoped today (verify: is the ledger one file per manager stateDir, or does it need a repo key filter? land-ledger.ts/done-proof.ts are single-file-per-stateDir with branch keys, not per-repo files — filter listPendingPrs(this.stateDir) by `.repo` at read time, matching how Observer scopes per-repo work off a single manager-wide `this.stateDir` already)
	const entries = listPendingPrs(this.stateDir).filter((e) => e.state === "open" || (e.state === "merged" && (!e.proofAt || !e.issueClosedAt)));
	if (entries.length === 0) return; // no work ⇒ this tick is a no-op, no gh calls at all
	for (const entry of entries) await this.reconcileOnePr(entry).catch(() => {});
	await this.ffHealCandidates().catch(() => {});
};
this.prReconcileTimer = setInterval(() => void prReconcileTick(), Number(process.env.OMP_SQUAD_PR_RECONCILE_INTERVAL_MS) || 120_000);
setTimeout(() => void prReconcileTick(), 20_000); // stagger after boot, past plan-sync's own 15s
```

Store the timer handle on a new `private prReconcileTimer?: ReturnType<typeof setInterval>;` field (mirrors `planSyncTimers`) and clear it in whatever shutdown/dispose path already clears `planSyncTimers` (grep for that at implementation time — likely a `stop()`/`shutdown()` method on `SquadManager`).

### 2. `reconcileOnePr(entry)` — per-entry reconciliation

For each open `PendingPr` entry, `gh pr view <prNumber> --repo <slug> --json state,headRefOid,mergeCommit` (via `ghJson`):

- **`state === "MERGED"` and entry not yet marked merged** (out-of-band GitHub-UI merge): `git fetch origin <defaultBranch>`, run the SAME per-method reachability assertion concern 06's `landAgentPr` uses (do not duplicate the logic — export `assertMerged` from `land-pr.ts` if it isn't already, and import it here). On success: `recordDoneProof(...)` with `mode: "pr"`, `verified: "green"` (note: this proof was NOT gated by the scratch-merge acceptance/regression gate, since the merge happened outside the daemon entirely — set `detail: "merged out-of-band via GitHub UI; gate not re-verified by the daemon"` so the DoneProof record is honest about what it does and doesn't attest to); find the agent record for `entry.branch` (if still on the roster) and clear `landReady`, call `recordLandOutcome(this.stateDir, entry.branch, true, "merged out-of-band")`, `closeLandedIssue(issue, { branch: entry.branch, repo })` (concern 04's proof-checked version — now finds the proof this step just wrote), `emitAgent(rec)` if the record still exists. `updatePendingPr(this.stateDir, entry.branch, { state: "merged", mergedAt: Date.now(), proofAt: Date.now() })`.
- **`state === "CLOSED"` and `headRefOid` unchanged from what the ledger recorded at push** (closed, not merged): `updatePendingPr(..., { state: "closed" })`; do NOT touch the branch or `landReady` — the design's explicit ruling (DESIGN.md "Closed-PR edge") is that a human decides here, the branch and one-tap Land affordance stay intact so a re-Land creates a fresh PR later. Surface a finding (reuse whatever finding/log channel the Observer uses, or a plain `this.log("warn", ...)` if this loop has no Observer-finding sink of its own — verify at implementation time which is more consistent with how other manager-loop surfacing already works).
- **Entry has `proofAt` set but no `issueClosedAt`** (crashed between DoneProof write and Plane close — the idempotency case DESIGN.md calls out, since `closePlaneIssue` is best-effort/swallowing per `squad-manager.ts:2852-2853`): retry `closeLandedIssue` for that issue/branch. On success, set `issueClosedAt` on the ledger entry — this field, not proof-existence, is what makes the retry idempotent (an already-closed issue is a no-op inside `closeLandedIssue`'s own `closedIssues` set, so retrying is always safe).
- **An agent has `landReady === true` and PR mode is resolved for its repo but NO ledger entry exists for its branch** (covers the crash-between-push-and-`gh pr create` case, and the case where `markLandReady`'s floated push+create silently failed): retry `ensurePr(...)` for that agent's branch.

### 3. `ffHealCandidates()` — best-effort fast-forward heal

For any repo resolved to PR mode where the local checkout is strictly BEHIND `origin/<default>` (compare local HEAD sha to fetched `origin/<default>` sha — NOT ahead, NOT diverged, purely behind) AND currently checked out on the default branch (same condition `resolveLandMode`'s probe 4 already checks — do not heal a deliberately-checked-out feature branch): `withRepoLandLock(repo, () => git(["fetch", "origin", defaultBranch]).then(() => git(["merge", "--ff-only", `origin/${defaultBranch}`])))`, best-effort (swallow failure, log it, try again next tick). This is the only place this concern touches the primary checkout, and only ever with `--ff-only` — it can never overwrite or lose local work, by construction (a strictly-behind fast-forward has nothing to lose).

## Cross-Repo Side Effects

None — single repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/pr-reconciler.test.ts` — with a mocked `gh` runner and a fake ledger:
  - Out-of-band merge: entry `state: "open"` + mocked `gh pr view` returning `MERGED` ⇒ DoneProof written, `landReady` cleared, `closeLandedIssue` called, ledger entry updated to `merged`/`proofAt` set.
  - Closed-unmerged: entry ⇒ `CLOSED` ⇒ ledger marked `closed`, agent's `landReady`/branch untouched, a finding/log surfaced.
  - Close-retry: entry with `proofAt` set, `issueClosedAt` unset ⇒ `closeLandedIssue` retried and `issueClosedAt` set on success; a second tick with `issueClosedAt` already set does NOT call `closeLandedIssue` again (idempotency via the ledger field, not proof-existence).
  - Push-retry: `landReady === true`, PR mode resolved, no ledger entry ⇒ `ensurePr` invoked exactly once per tick until an entry appears.
  - ff-heal: a repo strictly behind `origin/<default>` and on the default branch heals via `merge --ff-only`; a repo on a non-default branch, or ahead/diverged, is left untouched.
  - No-op guard: an empty ledger ⇒ zero `gh`/`git` calls for the whole tick (assert via the mock's call count).
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test` (full suite) — confirm this new always-on timer doesn't fire during other tests that don't set up a `stateDir`/ledger (should short-circuit on the empty-ledger no-op guard).
- `bun run check`

## Resolution

Closed 2026-07-04 via commit 7f5519c (+1ed2d63 review fixes) on branch worktree-research-direct-vs-glance. Always-on 120s PendingPr reconciler (not OBSERVE-gated): out-of-band merge reconcile, push retry, CLOSED-PR surfacing, close retry, guarded ff-heal.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).
