# PR land path

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land-pr.ts (new), src/land.ts, src/squad-manager.ts, src/types.ts, tests/land-pr.test.ts (new), tests/land-seam.test.ts (new)

## Goal

`landBranch` (the existing injectable seam over `landAgent`) becomes the universal mode-dispatching point: in local mode it calls `landAgent` exactly as today; in PR mode it calls a new synchronous `landAgentPr` primitive that pushes, ensures a PR exists, re-runs a scratch-worktree merge+gate at merge-click, merges via `gh pr merge`, asserts reachability, and writes a DoneProof — all under the SAME `withRepoLandLock` the local path already uses. `landFeature`, which today bypasses `landBranch` entirely by calling `landAgent` directly, is rerouted through the same seam so PR mode has no second, unguarded merge path.

**Imports consumed from concern 01** (`src/done-proof.ts`): `recordDoneProof`, `isAncestor`.
**Imports consumed from concern 05** (`src/land-mode.ts`, `src/gh.ts`): `resolveLandMode`, `aheadOfBase`, `gh`, `ghJson`, `ghAvailable`.

## Approach

### 1. `landBranch` — the seam, verified current body

`src/squad-manager.ts:1742-1744`:

```ts
/** Seam over the land.ts primitive so the single-agent land path is unit-testable (inject a fake land). */
protected landBranch(opts: LandOpts): Promise<LandResult> {
	return landAgent(opts);
}
```

Change to dispatch on the repo's resolved mode:

```ts
protected async landBranch(opts: LandOpts): Promise<LandResult> {
	const mode = await resolveLandMode(opts.repo);
	if (mode.mode === "pr" && mode.defaultBranch) {
		return landAgentPr({ ...opts, defaultBranch: mode.defaultBranch });
	}
	return landAgent(opts);
}
```

`land()` (verified `squad-manager.ts:1631-1695`) already calls `this.landBranch(...)` at line 1656 — no change needed there; it automatically gets PR-mode dispatch for free, which is the entire point of the seam living below `manager.land()`.

### 2. `landFeature` — reroute through the seam (closes RT2-1 / RT1-3's "PR mode disables merge-time gates" the OTHER way it could still happen)

Verified: `landFeature` (`squad-manager.ts:1585-1622`) calls `landAgent` DIRECTLY at line 1608 (`const res = await landAgent({ repo: pf.repo, worktree: w.worktree, branch: w.branch, ... });`), never going through `landBranch` — this is the exact bypass the design's RT2-1 finding named. Change line 1608 from `landAgent(...)` to `this.landBranch(...)` (same argument object, no other change to `landFeature`'s surrounding logic — the `proofGate` pre-check at :1596, the `landOrder`/`featureLandStatus` sequencing, and the `closeLandedIssue` call at :1616 with its concern-04 `ctx` param all stay exactly as they are). This one-line change is what makes feature-lands (multi-branch) inherit PR-mode dispatch instead of always local-merging regardless of the resolved mode — the two-worlds-inside-the-daemon hole the design calls out explicitly.

**Enforcement test requirement**: a test must assert that in PR mode, no code path reachable from `landFeature` OR `land()` ever invokes a real `git merge` against the PRIMARY checkout — inject a spied `GitRunner`/git-call tracker and assert zero `["merge", ...]` invocations with `cwd === repo` (the scratch-worktree merge in `landAgentPr` below runs `git merge` too, but against a *disposable detached worktree*, not `repo` — the test must distinguish cwd, not just the presence of the string `"merge"`).

### 3. `src/land-pr.ts` — new module

**`PendingPr` ledger** (verbatim shape from DESIGN.md, mirrors `land-ledger.ts`'s file-per-stateDir pattern — read that file again before writing this one, exact same idiom as concern 01's `DoneProof` ledger):

```ts
export interface PendingPr {
	branch: string;
	repo: string; // repoIdentity() key
	prNumber: number;
	prUrl: string;
	issueId?: string;
	issueIdentifier?: string;
	agentId?: string;
	createdAt: number;
	state: "open" | "merged" | "closed";
	mergedAt?: number;
	proofAt?: number;
	issueClosedAt?: number; // the three trailing fields are the reconciler's (concern 07) idempotency keys
}
```

File: `path.join(stateDir, "pending-prs.json")`, keyed by branch, same read-modify-write/best-effort idiom as `land-ledger.ts`. Export `readPendingPrLedger`, `recordPendingPr`, `getPendingPr(stateDir, branch)`, `updatePendingPr(stateDir, branch, patch: Partial<PendingPr>)`, `listPendingPrs(stateDir): PendingPr[]` (concern 07 iterates this).

**`ensurePr(rec)`** — idempotent PR-ensure, given `{ repo, branch, defaultBranch, title, body?, draft? }`:

1. `gh pr list --head <branch> --repo <slug> --json number,url,state` (via `ghJson` from `./gh.ts`). Caveat (verified in DESIGN's red-team resolution table, RT1-16/17/18): `gh pr list --head` only returns OPEN PRs by default — absent result does NOT mean no PR ever existed, it means no OPEN one. If found: adopt it into the `PendingPr` ledger (if not already recorded) and return its number/url — no push, no create.
2. If absent: push the branch. Verified async-floated call sites this integrates with: `markLandReady` (`squad-manager.ts:1714-1720`) and the `staged` site (`squad-manager.ts:1669`) both currently just flip `rec.dto.landReady = true` and emit — in PR mode, floating an `ensurePr(...)` call (fire-and-forget, `void ensurePr(...).catch(...)`) alongside that flip is what "landReady additionally floats an idempotent push + `gh pr create --draft`" means. Before pushing, check for a prior CLOSED/MERGED PR on this exact branch name (`gh pr list --head <branch> --state all --json number,state` — a second call, or fold into the first with `--state all` and branch on `state`): if one exists, the daemon owns `squad/*` branch names deterministically (verified: re-dispatched issues reuse `planeIssueBranch(issue)` — same name every time), so push with `--force-with-lease` rather than a plain push (which would fail non-fast-forward against the stale remote ref from the prior PR's branch).
3. `gh pr create --draft` (draft gated on `OMP_SQUAD_PR_DRAFT` default `"1"`) with `--base <defaultBranch> --head <branch>`.
4. `recordPendingPr(stateDir, { branch, repo, prNumber, prUrl, issueId, issueIdentifier, agentId, createdAt: Date.now(), state: "open" })`.
5. Return `{ prNumber, prUrl }`.

Map `gh pr create`/`gh pr ready` CLI errors (rate limit, auth expiry, branch-protection rule rejection) to a returned `{ ok: false, detail }` rather than throwing — every `gh` failure degrades to a surfaced refusal per the design's risk mitigation, never an unhandled daemon crash.

**`landAgentPr(opts)`** — synchronous end-to-end, called from `landBranch` under the SAME lock the local path uses:

```ts
export async function landAgentPr(opts: LandOpts & { defaultBranch: string }): Promise<LandResult> {
	return withRepoLandLock(opts.repo, async () => {
		const ensure = await ensurePr({ repo: opts.repo, branch: opts.branch!, defaultBranch: opts.defaultBranch, title: opts.message });
		if (!ensure.ok) return { ok: false, committed: false, merged: false, message: opts.message, detail: ensure.detail };

		// Re-check proof against the CURRENT branch tip — a stale proof from before new commits landed on
		// the branch must not authorize a merge of commits it never saw.
		if (opts.requireProof) {
			const reason = await proofGate(opts.repo, opts.worktree, opts.branch);
			if (reason) return { ok: false, committed: false, merged: false, message: opts.message, detail: reason };
		}

		await git(["fetch", "origin", opts.defaultBranch], opts.repo);

		// Scratch-merge gate: disposable detached worktree of freshly-fetched origin/<default>, merge the
		// branch into it, run acceptance + the (now-default-ON, concern 03) regression gate THERE — never
		// touching the primary checkout. Conflict here is NOT a failure yet — see the retry-once path below.
		const scratch = await mkScratchWorktree(opts.repo, opts.defaultBranch); // `git worktree add --detach <tmp> origin/<default>`
		try {
			const merge = await git(["merge", "--no-ff", opts.branch], scratch);
			if (merge.code !== 0) {
				await git(["merge", "--abort"], scratch).catch(() => {});
				// Conflict: attempt a CLEAN automerge of origin/<default> into the AGENT's own worktree (not
				// the scratch copy) — if that resolves cleanly, push and retry landAgentPr ONCE; if it still
				// conflicts, refuse with the exact conflict file list, never silently drop the PR.
				const retryResult = await attemptCleanAutomergeAndRetry(opts);
				return retryResult; // {ok:false, retryable:false, detail: "<exact files>"} on a real conflict
			}
			const verify = opts.verify ?? (await detectVerify(opts.repo));
			if (verify) {
				const gate = await runGate(verify, scratch);
				if (gate.code !== 0) return { ok: false, committed: false, merged: false, message: opts.message, detail: `acceptance failed on scratch merge: ${truncate(gate.output, 600)}` };
			}
			const regressionBlock = await applyRegressionGate({
				repo: scratch, head0: (await git(["rev-parse", `origin/${opts.defaultBranch}`], opts.repo)).stdout,
				committed: true, message: opts.message, branch: opts.branch!,
				reMerge: () => git(["merge", "--no-ff", opts.branch!], scratch),
			});
			if (regressionBlock) return regressionBlock;
		} finally {
			await removeScratchWorktree(opts.repo, scratch);
		}

		// Green — merge via gh, not git.
		const method = process.env.OMP_SQUAD_PR_MERGE_METHOD || "merge";
		await gh(["pr", "ready", String(ensure.prNumber)], opts.repo);
		const merged = await gh(["pr", "merge", String(ensure.prNumber), `--${method}`, "--delete-branch=false"], opts.repo);
		if (merged.code !== 0) return { ok: false, committed: false, merged: false, message: opts.message, detail: `gh pr merge failed: ${merged.stderr}`, retryable: true };

		await git(["fetch", "origin", opts.defaultBranch], opts.repo);
		const assertion = await assertMerged(opts, ensure.prNumber, method);
		if (!assertion.ok) return { ok: false, committed: false, merged: false, message: opts.message, detail: assertion.detail };

		recordDoneProof(stateDir, {
			branch: opts.branch!, repo: repoIdentity(opts.repo), mode: "pr", method: method as "merge" | "squash" | "rebase",
			commit: assertion.commit, mergeCommit: assertion.mergeCommit, baseRef: `origin/${opts.defaultBranch}`,
			verified: "green", detail: "PR merged, scratch gate green", provenAt: Date.now(), prNumber: ensure.prNumber, prUrl: ensure.prUrl,
		});
		updatePendingPr(stateDir, opts.branch!, { state: "merged", mergedAt: Date.now(), proofAt: Date.now() });

		return { ok: true, committed: true, merged: true, message: opts.message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, prState: "merged" };
	});
}
```

(This is a design sketch showing every gate/assertion in order and where the ledger writes happen — the implementer must fill in `stateDir` threading (`landAgentPr` needs it passed in, likely as an added field on `LandOpts` or a second parameter, since `land.ts` today has no `stateDir` concept at all — decide at implementation time whether to add it to `LandOpts` or pass it as a second arg from `landBranch`, matching whichever is less invasive to the existing `LandOpts` consumers) and the exact helper bodies for `mkScratchWorktree`/`removeScratchWorktree`/`attemptCleanAutomergeAndRetry`/`assertMerged` per the per-method assertion rule below.)

**`applyRegressionGate` reuse — verified, no signature refactor needed**: `src/land.ts:219-264`'s `applyRegressionGate(p: { repo, head0, committed, message, branch, reMerge })` already takes an explicit `repo` field that IS the cwd every git/gate call in its body runs against (`git(["reset","--hard", p.head0], p.repo)`, `runGate(fullSuite, p.repo)`) — it has no hidden assumption that `p.repo` is the primary checkout. Passing the SCRATCH worktree path as `p.repo` and a scratch-local re-merge callback as `p.reMerge` works with the function exactly as it exists today. The only change needed in `land.ts` is adding the `export` keyword to `applyRegressionGate` (currently `async function applyRegressionGate(...)`, not exported) so `land-pr.ts` can import it.

**Per-method reachability assertion** (`assertMerged`):
- `method === "merge"`: `isAncestor(branchTipSha, \`origin/${defaultBranch}\`, repo)` (concern 01's helper) — a real merge preserves ancestry, so this is sufficient.
- `method === "squash" | "rebase"`: `gh pr view <prNumber> --json state,headRefOid` — assert `state === "MERGED"`, `headRefOid === branchTipSha` (the PR's recorded head matches what was actually landed, not a later force-push nobody reviewed), AND the reported merge commit is reachable from fetched `origin/<default>` via `isAncestor`.

**Conflict handling**: `attemptCleanAutomergeAndRetry` runs `git merge origin/<default>` (NOT `--no-ff` forced, a normal merge attempt) in the AGENT's own worktree (`opts.worktree`, not the scratch copy). Clean (exit 0) ⇒ push the result, retry `landAgentPr` exactly ONCE (guard a recursion flag so a second conflict does not retry forever). Still conflicted ⇒ `git merge --abort` in the agent worktree, return `{ ok: false, retryable: false, detail: "conflict in <files...>" }` with the exact `git diff --name-only --diff-filter=U` file list. The LLM `attemptAutoResolve` port to an origin-base scratch merge is explicitly CUT from this wave (documented regression, DESIGN.md Risk #4) — do not attempt to port it here.

### 4. `LandResult` extension — `src/land.ts:18-43`

Add optional fields (verified current interface has `ok/committed/merged/message/detail?/staged?/retryable?/forcedWithoutProof?`):

```ts
	mode?: "local" | "pr";
	pushed?: boolean;
	prUrl?: string;
	prNumber?: number;
	prState?: "draft" | "open" | "merged" | "closed";
```

### 5. `AgentDTO` — `src/types.ts:435-523`

Verified `landReady?: boolean;` at line 515. Add immediately after it:

```ts
	/** PR-mode landing metadata, set at push (draft/open) and merge (merged) time. Absent in local mode. */
	prUrl?: string;
	prNumber?: number;
	prState?: "draft" | "open" | "merged" | "closed";
```

These are set directly on `rec.dto` at the push/merge sites (the same pattern `landReady` already uses — verified `rec.dto.landReady = true` assignments at `squad-manager.ts:1669`/`:1717`, not object-literal construction), NOT threaded through the DTO-construction literals at creation time (verified construction sites `squad-manager.ts:860, 2121, 2324, 2351`) — being optional, they simply don't exist until a push/merge happens, exactly like `landReady` and `adopted` today.

### 6. `autoLand` × PR matrix

Verified `autoLandWorkflow` (`squad-manager.ts:1697-1708`) calls `this.land(id)` via `autoLandOnSuccess`'s injected `land` dependency — since dispatch to PR mode happens INSIDE `land()` → `landBranch()`, this path needs zero changes: full-auto (`autoLand && !landConfirm`) already runs the same synchronous gated `landAgentPr` once mode resolves to `pr`. `merged: true` on the returned `LandResult` is only ever set after `assertMerged` passes, so nothing downstream (the `recordLandOutcome`/`closeLandedIssue` calls at `squad-manager.ts:1678/1689`, both unchanged by this concern) can observe a false "merged" for an unconfirmed PR merge.

## Cross-Repo Side Effects

None — single repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/land-pr.test.ts` — with mocked `gh`/`git` runners: `ensurePr` idempotency (existing open PR adopted, no double-create); force-with-lease branch reuse when a prior PR on the same branch name was closed/merged; scratch-gate green ⇒ merge + assertion + DoneProof write; scratch-gate red (acceptance fail, and separately regression-gate fail) ⇒ refused, PR left open, no DoneProof written; conflict ⇒ clean-automerge-and-retry-once succeeds on a trailing-main fixture, and separately a genuinely conflicting fixture returns `{ok:false, retryable:false}` with the exact file list; per-method assertion: `merge` checks ancestry, `squash`/`rebase` check `gh pr view` state+headRefOid+mergeCommit-ancestry.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/land-seam.test.ts` — the enforcement test from §2: in PR mode, zero `git merge` invocations against the primary checkout (`cwd === repo`) across both `land()` and `landFeature()`'s full call graph, using a spied `GitRunner`.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/land.test.ts tests/squad-manager*.test.ts` — local-mode behavior byte-identical to pre-concern (regression guard: `landBranch` in local mode is still a pure passthrough to `landAgent`).
- `bun run check`

## Resolution

Closed 2026-07-04 via commit 13d40c1 (+ed93bcf review fixes) on branch worktree-research-direct-vs-glance. landBranch mode dispatch + landFeature reroute; ensurePr idempotent push+draft; synchronous landAgentPr with scratch-merge gate (acceptance + regression) and per-method post-merge assertion; no-git-merge-in-pr-mode enforcement test.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).
