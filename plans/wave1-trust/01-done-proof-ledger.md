# Done-proof ledger

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/done-proof.ts (new), src/land.ts, src/squad-manager.ts, tests/done-proof.test.ts (new)

## Goal

Introduce `DoneProof` — a small, retrievable, per-repo ledger keyed by branch (with an issue-identifier index) that is the ONE artifact that can later authorize a Done write (concern 04) or a PR-mode reachability claim (concern 06). This concern does not gate anything yet and does not know about PRs; it only builds the ledger, the `isAncestor` git primitive both later concerns need, and folds `land.ts`'s existing (write-only, never-read) `recordMainProof` audit trail into it so a LOCAL land's proof becomes retrievable, not just a JSON file nobody reads back.

## Approach

### 1. `src/done-proof.ts` — new module, mirrors `src/land-ledger.ts`'s pattern exactly

Read `src/land-ledger.ts` in full before writing this (122 lines, sync read-modify-write over one JSON file per `stateDir`, `existsSync`/`readFileSync`/`writeFileSync`, best-effort — a disk failure must never break a land). Do not add locking; the daemon is single-writer/single-event-loop like every other ledger in this codebase.

Data shape (verbatim from `plans/wave1-trust/DESIGN.md` "Data shapes"):

```ts
export interface DoneProof {
	branch: string;
	repo: string; // repoIdentity() key (src/repo-identity.ts) — NOT the host-local path
	issueId?: string;
	issueIdentifier?: string;
	mode: "local" | "pr";
	method?: "merge" | "squash" | "rebase"; // pr only
	commit: string; // branch tip proven included
	mergeCommit?: string; // pr only
	baseRef: string; // "HEAD" (local) | "origin/main" or similar (pr)
	verified: "green" | "red-baseline" | "unverified";
	detail: string;
	provenAt: number;
	prNumber?: number;
	prUrl?: string;
}
```

Ledger file: `path.join(stateDir, "done-proofs.json")`. Shape on disk:

```ts
interface DoneProofLedger {
	byBranch: Record<string, DoneProof>;
	byIssue: Record<string /* issueIdentifier, uppercased */, string /* branch */>;
}
```

Exported functions (names chosen to mirror `land-ledger.ts`'s `readLandLedger`/`writeLandLedger`/`recordLandOutcome` naming):

- `readDoneProofLedger(stateDir: string): DoneProofLedger` — try/catch, default `{ byBranch: {}, byIssue: {} }` on missing/corrupt file (same pattern as `land-ledger.ts:34-43`).
- `recordDoneProof(stateDir: string, proof: DoneProof): void` — read-modify-write: `ledger.byBranch[proof.branch] = proof`; if `proof.issueIdentifier` set, `ledger.byIssue[proof.issueIdentifier.toUpperCase()] = proof.branch` (most-recent-branch-wins — a re-dispatched issue's newest land is what "done" should mean). Best-effort write (swallow errors, same as `land-ledger.ts:45-51`).
- `getDoneProofByBranch(stateDir: string, branch: string): DoneProof | undefined`.
- `getDoneProofByIssue(stateDir: string, issueIdentifier: string): DoneProof | undefined` — looks up `byIssue[identifier.toUpperCase()]` then `byBranch[that]`.
- `hasProof(stateDir: string, issueIdentifier: string): boolean` — `getDoneProofByIssue(...) !== undefined`. This is the exact function name concern 04's `syncPlanStatuses` dependency injection (`hasProof(identifier)`) and `issueAlreadyDone`'s close-half consume — do not rename it once concern 04 starts.

### 2. `isAncestor` — new git primitive, exported from `src/done-proof.ts`

```ts
export async function isAncestor(ref: string, base: string, cwd: string): Promise<boolean> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "merge-base", "--is-ancestor", ref, base], {
		cwd,
		env: { ...process.env, ...GIT_HARDEN_ENV },
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await proc.exited) === 0; // git merge-base --is-ancestor: exit 0 = yes, 1 = no, other = error (treat as false)
}
```

Import `GIT_HARDEN_ARGS`/`GIT_HARDEN_ENV` from `./git-harden.ts` (same import every other git-shelling module in `src/` uses — verified in `land.ts:16`, `worktree.ts:8`, `proof.ts:19`). This is the ONLY new git primitive in this concern; concern 05's `resolveLandMode` probe and concern 06's post-merge reachability assertion both import it from here rather than re-implementing `merge-base --is-ancestor`.

### 3. Fold `recordMainProof` into the ledger (does not replace `proof.ts`'s existing store)

Verified: `src/land.ts:169-171` —

```ts
async function recordMainProof(repo: string, command: string, ok: boolean, detail: string, sandboxed: boolean): Promise<void> {
	await recordProof({ repo, worktree: repo, command, ok, detail, sandboxed }).catch(() => {});
}
```

Call sites (verified, all four are `await recordMainProof(...)`): `land.ts:378`, `:387`, `:413`, `:573`. This function still writes the legacy `proof.ts` store (`recordProof`, keyed to `<stateDir>/proof/<repo-hash>/<worktree-hash>.json`) — **do not remove that write**; it stays the audit-record every other proof consumer already reads via `proofGate`. Add a SECOND write, delegating into the new DoneProof ledger, but **only from the manager layer**, not inside `recordMainProof` itself — `recordMainProof` runs deep inside `landAgentImpl` where there is no `stateDir`, no `dto.branch`, and no `dto.issue` in scope (it only has `repo`/`command`/`ok`/`detail`/`sandboxed`). Threading those through would mean widening `LandOpts`/`LandResult` just to plumb identity down and back up — the design's own resolution for RT1-12 is explicit that the proof write belongs at the manager layer, where `dto.branch` + `dto.issue` + `LandResult` already coexist. Leave `recordMainProof` and its four call sites completely unchanged in this concern.

### 4. Manager-layer proof write — `SquadManager.land()`

Verified current body, `src/squad-manager.ts:1686-1691`:

```ts
if (result.ok) {
	rec.dto.landReady = false; // successful land attempt ⇒ clear the confirm-mode staged flag
	this.emitAgent(rec);
	if (result.merged) await this.closeLandedIssue(dto.issue); // real merge ⇒ close its tracking issue (idempotent, best-effort)
	else this.log("info", `not closing ${dto.issue?.identifier ?? dto.issue?.id ?? id}: land made no merge`);
}
```

Insert the DoneProof write inside the `if (result.merged)` branch, BEFORE `closeLandedIssue` (concern 04 makes `closeLandedIssue` consult this same proof, so it must exist first):

```ts
if (result.merged) {
	recordDoneProof(this.stateDir, {
		branch: dto.branch ?? "", repo: repoIdentity(dto.repo), issueId: dto.issue?.id, issueIdentifier: dto.issue?.identifier,
		mode: "local", commit: dto.branch ? (await headCommit(dto.worktree)) : "", baseRef: "HEAD",
		verified: result.ok ? "green" : "red-baseline", // land.ts's own red-baseline escape (verifyMerged :390-414) already returns ok:true with an honest detail in that case — verify at implementation time whether `result.ok` alone distinguishes green from red-baseline, or whether `result.detail`'s text needs a substring check (land.ts's red-baseline path text, verified at :390-414, does not set a distinct boolean flag on LandResult today)
		detail: result.detail ?? result.message, provenAt: Date.now(),
	});
	await this.closeLandedIssue(dto.issue);
}
```

Import `recordDoneProof` from `./done-proof.ts` and `headCommit` from `./proof.ts` (verified exported at `proof.ts:77-79`) and `repoIdentity` from `./repo-identity.ts` (verified exported at `repo-identity.ts:31`) at the top of `squad-manager.ts`. Do NOT touch anything else in this 1686-1691 region, and do not touch `landFeature`'s parallel `closeLandedIssue` call at `squad-manager.ts:1616` in this concern — that is concern 06's seam (it currently calls `landAgent` directly, bypassing `landBranch`, at `:1608`; wiring `landFeature` through the DoneProof write happens naturally once concern 06 reroutes it through `land()`'s sibling seam — do not duplicate the write here for `landFeature` and risk two divergent copies of this logic).

**Tri-state verification note**: `result.ok`/`result.detail` today do not carry a clean green-vs-red-baseline boolean. Read `land.ts`'s `verifyMerged` (verified :372-415) and its red-baseline escape (:390-414) at implementation time: if it returns `{ ok: true, ... }` in the red-baseline case with a `detail` string that says so (verify the exact wording), key `verified: "red-baseline"` off a substring match on that wording (e.g. `result.detail?.includes("red baseline") ? "red-baseline" : "green"`), documenting the exact match string in a code comment so it does not silently stop matching if `land.ts`'s wording changes later. If no such distinguishing text exists, default to `"green"` for any `result.ok === true` merge and file that gap as a one-line TODO comment — do not block this concern on inventing new plumbing in `land.ts` to carry the tri-state explicitly (that widening is out of scope here; DESIGN.md's `recordMainProof` delegation note says "folds in," not "refactors").

### 5. Tests — `tests/done-proof.test.ts`

- Ledger round-trip: `recordDoneProof` then `getDoneProofByBranch`/`getDoneProofByIssue`/`hasProof` return the recorded entry; a second `recordDoneProof` for the same branch overwrites; a second issue-identifier record for a DIFFERENT branch updates `byIssue` to point at the newer branch (most-recent-wins).
- Corrupt/missing file ⇒ `readDoneProofLedger` returns the empty shape, never throws.
- `isAncestor`: build two temp git repos (or one repo with two branches) via `Bun.spawnSync`/`git()`-style helpers in a temp dir (mirror the pattern other tests in this repo use for git fixtures, e.g. `tests/land-regression-gate.test.ts` or `worktree.ts`'s own test file) — assert `isAncestor(ancestorSha, tipSha, cwd)` is `true` and `isAncestor(tipSha, ancestorSha, cwd)` is `false` for a fast-forward-only relationship, and `false` for two unrelated diverged commits.
- `land()` delegation: inject a fake `landBranch` (the existing seam, `squad-manager.ts:1742-1744`) returning `{ ok: true, committed: true, merged: true, message: "ok" }`; call `manager.land(id)`; assert `getDoneProofByBranch(stateDir, dto.branch)` now returns a `DoneProof` with `mode: "local"` and `verified: "green"`, and that the legacy `recordMainProof`/`recordProof` store is untouched (still exercised via `land.ts`'s own existing tests — do not duplicate those here).

## Cross-Repo Side Effects

None — single repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/done-proof.test.ts` — ledger round-trip, tri-state, `isAncestor` fast-forward/diverged cases, and the `land()` delegation test above.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/land.test.ts tests/squad-manager*.test.ts` (whichever existing files cover `land()` today) — no change in observable `LandResult` shape or behavior; the new ledger write is additive and best-effort.
- `bun run check`

## Resolution

Closed 2026-07-04 via commit 690e414 on branch worktree-research-direct-vs-glance. DoneProof ledger (done-proofs.json, tri-state verified) + isAncestor primitive + manager-layer proof write on local land; 10 new tests.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).
