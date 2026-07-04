# Land-mode probe and origin-aware ahead-of

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/land-mode.ts (new), src/gh.ts (new), src/worktree.ts, src/squad-manager.ts, src/observer.ts, tests/land-mode.test.ts (new), tests/ahead-of-base.test.ts (new)

## Goal

Per-repo, auto-probed resolution of local-vs-PR landing mode, safe by construction (every individual failure mode from the design's red-team — host-aliased origin, diverged repo, no push capability, non-default checkout — independently forces local mode with a loud log, never a silent wrong guess). Replace every `rev-list HEAD..branch`-style "ahead" computation in the codebase with ONE origin-aware `aheadOfBase` primitive, and make DoneProof (concern 01) the FIRST thing consulted — before any arithmetic — everywhere "is this branch landed" is asked.

**Imports consumed from concern 01** (`src/done-proof.ts`): `isAncestor`, `hasProof`, `getDoneProofByBranch`.

## Approach

### 1. `src/gh.ts` — new thin `gh` CLI wrapper, mirrors `land.ts`'s `git()` helper

Verified pattern to mirror, `src/land.ts:122-137`:

```ts
interface GitRun { code: number; stdout: string; stderr: string; }
async function git(args: string[], cwd: string): Promise<GitRun> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
```

Write `src/gh.ts`:

```ts
export interface GhRun { code: number; stdout: string; stderr: string; }

async function ghRaw(args: string[], cwd: string): Promise<GhRun> {
	const proc = Bun.spawn(["gh", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function gh(args: string[], cwd: string): Promise<GhRun> {
	return ghRaw(args, cwd);
}

/** Parse `gh`'s `--json` output; undefined on a non-zero exit or unparsable body — never throws. */
export async function ghJson<T>(args: string[], cwd: string): Promise<T | undefined> {
	const r = await ghRaw(args, cwd);
	if (r.code !== 0) return undefined;
	try { return JSON.parse(r.stdout) as T; } catch { return undefined; }
}

/** Feature-detect: is `gh` installed and authenticated in a way that can run at all. */
export async function ghAvailable(cwd = process.cwd()): Promise<boolean> {
	const r = await ghRaw(["auth", "status"], cwd);
	return r.code === 0;
}
```

No `GIT_HARDEN_ARGS`/env needed here — `gh` is a distinct binary with its own auth/config surface, not a git subprocess; do not reuse the git-hardening constants for it. Injectable-runner pattern (a `run` param defaulting to `ghRaw`) is NOT needed at this layer — concern 06 and this concern's own tests inject fakes by mocking the exported `gh`/`ghJson` functions directly (standard Bun test module-mock pattern used elsewhere in this repo), matching how `land.ts` itself has no injectable git runner either.

### 2. `src/land-mode.ts` — new module, the 5-point probe

```ts
export type LandMode = "auto" | "pr" | "local";
export interface ResolvedLandMode {
	mode: "pr" | "local"; // resolved, never "auto" — auto always collapses to one of these
	defaultBranch?: string; // gh-reported default (pr mode only)
	reason: string; // which probe passed/failed — always logged
}

const cache = new Map<string, { resolved: ResolvedLandMode; at: number }>();
const TTL_MS = 5 * 60_000;

export async function resolveLandMode(repo: string): Promise<ResolvedLandMode> {
	const configured = (process.env.OMP_SQUAD_LAND_MODE ?? "auto") as LandMode;
	if (configured === "local") return { mode: "local", reason: "OMP_SQUAD_LAND_MODE=local" };
	if (configured === "pr") return { mode: "pr", reason: "OMP_SQUAD_LAND_MODE=pr (forced, probes skipped)" };

	const cached = cache.get(repo);
	if (cached && Date.now() - cached.at < TTL_MS) return cached.resolved;

	const resolved = await probe(repo);
	cache.set(repo, { resolved, at: Date.now() });
	return resolved;
}

async function probe(repo: string): Promise<ResolvedLandMode> {
	// 1. owner/repo slug from origin — repoIdentity()/normalizeGitUrl() (src/repo-identity.ts:18-31) return
	//    "<host>/<owner>/<repo>" and do NOT collapse a host alias (verified: git@github.com-personal:owner/repo.git
	//    normalizes to "github.com-personal/owner/repo", not "github.com/owner/repo") — this is exactly why a
	//    URL-host check would fail on the flagship repo and why gh must be addressed by slug, not host.
	const identity = repoIdentity(repo); // "host/owner/repo" — 3 segments (or fewer if origin is missing)
	const parts = identity.split("/");
	if (parts.length < 3) return { mode: "local", reason: `no parseable owner/repo from origin (${identity})` };
	const slug = parts.slice(-2).join("/"); // "owner/repo"

	// 2. gh repo view <slug> --json defaultBranchRef
	const view = await ghJson<{ defaultBranchRef: { name: string } }>(["repo", "view", slug, "--json", "defaultBranchRef"], repo);
	if (!view?.defaultBranchRef?.name) return { mode: "local", reason: `gh repo view ${slug} failed or has no default branch` };
	const defaultBranch = process.env.OMP_SQUAD_PR_BASE || view.defaultBranchRef.name;

	// 3. git push --dry-run origin <default>
	const dryRun = await git(["push", "--dry-run", "origin", defaultBranch], repo);
	if (dryRun.code !== 0) return { mode: "local", reason: `git push --dry-run origin ${defaultBranch} failed: ${dryRun.stderr}` };

	// 4. current local branch == remote default
	const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
	if (current.stdout !== defaultBranch) return { mode: "local", reason: `checked-out branch ${current.stdout} != remote default ${defaultBranch} — deliberate operator checkout wins` };

	// 5. local default is ancestor of fetched origin/<default> — divergence forces local + loud log
	await git(["fetch", "origin", defaultBranch], repo).catch(() => {});
	const localSha = (await git(["rev-parse", "HEAD"], repo)).stdout;
	const ancestor = await isAncestor(localSha, `origin/${defaultBranch}`, repo);
	if (!ancestor) return { mode: "local", reason: `local ${defaultBranch} is NOT an ancestor of origin/${defaultBranch} — diverged, forcing local mode until reconciled (see boot warning)` };

	return { mode: "pr", defaultBranch, reason: `all 5 probes passed (slug ${slug}, default ${defaultBranch})` };
}
```

Import `git`/`GhRun`-equivalent from a small local copy of the `git()` helper (or export it from `land.ts` if that's cleaner — check at implementation time whether exporting `land.ts`'s private `git()` is simpler than duplicating it; either is acceptable, but do not silently diverge its hardening args), `ghJson` from `./gh.ts`, `repoIdentity` from `./repo-identity.ts`, and `isAncestor` from `./done-proof.ts` (concern 01).

Log the resolved mode + reason per repo at boot: call `resolveLandMode(repo)` once during `SquadManager`'s Observer/plan-sync repo-iteration setup (verified `squad-manager.ts:554-556`, the `observeRepos` computation) and `this.log("info", ...)` the result for every configured Plane repo, so an operator sees "landing in PR mode for X (all 5 probes passed)" or "landing LOCAL for Y (diverged...)" without digging.

### 3. `addWorktree` gains `startPoint`

Verified current signature, `src/worktree.ts:68-105`:

```ts
export async function addWorktree(opts: {
	repo: string;
	branch: string;
	dir?: string;
	base?: string; // verified: this is a DIRECTORY (worktree base dir override), not a git ref
}, run: GitRunner = runGit): Promise<CreatedWorktree> {
	...
	const args = exists
		? ["worktree", "add", dir, opts.branch]
		: ["worktree", "add", "-b", opts.branch, dir]; // verified: no commit-ish given ⇒ forks from repo's current HEAD
	...
}
```

Add `startPoint?: string` to the options object; when the branch doesn't already exist AND `startPoint` is given, append it as the git start-point argument:

```ts
	const args = exists
		? ["worktree", "add", dir, opts.branch]
		: opts.startPoint
			? ["worktree", "add", "-b", opts.branch, dir, opts.startPoint]
			: ["worktree", "add", "-b", opts.branch, dir];
```

Thread it through `resolveWorktree` (verified `worktree.ts:132-146`, currently `(repo, branch, add, gitProbe, base?)`): add a 6th optional param `startPoint?: string`, passed into `add({ repo, branch, base, startPoint })`.

Thread it from the ONE call site, `SquadManager.create()` (verified `squad-manager.ts:2079`, `const wt = await resolveWorktree(opts.repo, branch, addWorktree, isGitRepo, this.worktreeBaseDir);`): before this call, when `(await resolveLandMode(opts.repo)).mode === "pr"`, fetch `origin/<default>` and pass `\`origin/${defaultBranch}\`` as `startPoint` so a PR-mode agent's worktree forks from freshly-fetched upstream, not the (possibly stale/diverged, though probe 5 already checked convergence) local HEAD:

```ts
const landMode = await resolveLandMode(opts.repo);
const startPoint = landMode.mode === "pr" && landMode.defaultBranch
	? (await git(["fetch", "origin", landMode.defaultBranch], opts.repo).catch(() => {}), `origin/${landMode.defaultBranch}`)
	: undefined;
const wt = await resolveWorktree(opts.repo, branch, addWorktree, isGitRepo, this.worktreeBaseDir, startPoint);
```

(Write this as two statements, not a comma-expression, at implementation time — the inline form above is for illustrating the fetch-then-value shape only.)

### 4. ONE `aheadOfBase` primitive — replaces every rev-list-based "ahead" computation

New export in `src/land-mode.ts`:

```ts
export async function aheadOfBase(opts: { repo: string; branch: string; cwd?: string }): Promise<number> {
	const cwd = opts.cwd ?? opts.repo;
	const mode = await resolveLandMode(opts.repo);
	if (mode.mode === "pr" && mode.defaultBranch) {
		await throttledFetch(opts.repo, mode.defaultBranch); // internal: fetch at most once per TTL window, reuse resolveLandMode's cache timing
		const r = await git(["rev-list", "--count", `origin/${mode.defaultBranch}..${opts.branch}`], cwd);
		return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1;
	}
	const r = await git(["rev-list", "--count", `HEAD..${opts.branch}`], cwd);
	return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1;
}
```

Swap into every consumer (all four are currently SYNCHRONOUS local rev-list computations — this is a real async ripple, called out explicitly below, not a drop-in):

- **`aheadOfMain`** (verified `squad-manager.ts:1816-1820`, currently `private aheadOfMain(a: AgentDTO): number` using `hardenedGitSync`) becomes `private async aheadOfMain(a: AgentDTO): Promise<number> { if (!a.branch) return -1; return aheadOfBase({ repo: a.repo, branch: a.branch, cwd: a.worktree }); }`.
- **`agentHasUnlandedWork`** (verified `squad-manager.ts:1804-1811`, inline `Bun.spawnSync(["git","-C",rec.dto.repo,"rev-list","--count",...])`) — replace the inline spawn with `(await aheadOfBase({ repo: rec.dto.repo, branch: rec.dto.branch, cwd: rec.dto.worktree })) > 0` (function is already `async`, no new ripple here).
- **Reaper input** (verified `squad-manager.ts:3354-3396` `reapDeadWorktrees`, computing `aheadOfBase: w.isPrimary || !w.branch ? 0 : await branchAhead(root, w.branch, base)` at line 3372, where `base = await primaryBranch(root)` at :3363 and `branchAhead` is `worktree.ts:193`) — this one is already async and already named `aheadOfBase` as a LOCAL FIELD name (do not confuse with the new module-level function of the same name; rename the reaper's local field or the import to avoid a same-name shadow). Replace the `branchAhead(root, w.branch, base)` call with the new module's `aheadOfBase({ repo: root, branch: w.branch, cwd: root })` so a pushed-but-unmerged PR branch is correctly NOT ahead-0 against `origin/<default>` even though it may be ahead-0 against the local (never-advancing, in PR mode) main. `worktree.ts`'s own `branchAhead` export (verified `worktree.ts:193`) stays as a low-level primitive other callers may still use for a literal local comparison — do not delete it, just stop routing the reaper's decision through it alone.
- **Observer's injected `aheadOf`** (verified `squad-manager.ts:556-577` Observer construction, `gitAheadOfMain: (a) => this.aheadOfMain(a)` at line 566) — since `aheadOfMain` is now `async`, this callback's type must change from `(a: AgentDTO) => number` to `(a: AgentDTO) => Promise<number>` in `src/observer.ts`'s constructor options type AND in both consuming Check functions (`auditLandedSurvivors` verified `observer.ts:166-182` and `auditStaleDone` verified `observer.ts:196-220`), which currently call `aheadOf(a)` synchronously inline inside a `.filter()`/loop. Convert both to `async` functions returning `Promise<Finding[]>`, replace the synchronous filter/loop with an explicit `for` loop that `await`s `aheadOf(a)` per agent (a `.filter()` cannot await), and update their call sites inside `Observer`'s tick loop to `await` them. This is the one place in this concern where "swap the primitive" is not mechanical — budget real time for it, and do not let it regress the two checks' existing filtering logic (verified above) while converting the control flow.

### 5. DoneProof consulted FIRST — Observer checks 2/4 and the reaper

In `auditLandedSurvivors` (Check 2, `observer.ts:166-182`) and `auditStaleDone` (Check 4, `observer.ts:196-220`), both currently decide purely off `aheadOf(a)`. Add a DoneProof short-circuit BEFORE the arithmetic in both: if `a.branch` has a DoneProof on record (`getDoneProofByBranch(stateDir, a.branch)` — thread `stateDir` into Observer's constructor deps alongside the existing `landLedger`/`stateDir` fields already there per the verified construction at `squad-manager.ts:569-570`), treat the branch as landed regardless of what `aheadOf(a)` returns — squash/rebase merges make the rev-list arithmetic permanently nonzero even when the work is safely in origin/default. Concretely: in `auditStaleDone`, the `stale` filter (`observer.ts:197`, `agents.filter((a) => a.issue && !openIds.has(a.issue.id) && aheadOf(a) > 0)`) gains a leading `&& !hasDoneProof(a)` condition; in `auditLandedSurvivors`, the `aheadOf(a) !== 0` skip condition (`observer.ts:171`) is unaffected by proof presence (a proof only ever makes MORE things look landed, never fewer) but note the reap decision itself is unaffected by this concern — only the "still needs reopening" call in check 4 changes behavior.

Same short-circuit in `reapDeadWorktrees`: before computing `aheadOfBase` for a worktree, check `getDoneProofByBranch(this.stateDir, w.branch)` — a proven-landed branch is eligible for reaping regardless of the arithmetic result (mirrors `selectReapable`'s existing "merged" reason path; verified at `worktree-reaper.ts:77` — read that function's input shape at implementation time and add a `proven?: boolean` flag per worktree info entry that `selectReapable` treats as equivalent to `aheadOfBase === 0`).

## Cross-Repo Side Effects

None — single repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/land-mode.test.ts` — probe matrix with a mocked `git`/`gh` runner: each of the 5 probes independently failing forces `local` with the expected `reason` string; all 5 passing resolves `pr`; `OMP_SQUAD_LAND_MODE=local`/`=pr` bypass the probe entirely; TTL cache reuses a resolution within the window and re-probes after it expires.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/ahead-of-base.test.ts` — `aheadOfBase` in local mode matches the old `HEAD..branch` behavior exactly (regression guard); in PR mode (mocked `resolveLandMode` returning `pr`) it counts against `origin/<default>..branch` instead; the reaper/Observer/`agentHasUnlandedWork` call sites all route through the same function (assert via a spy/mock rather than re-testing the arithmetic four times).
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/observer.test.ts` — proof-first short-circuit: a branch with a recorded DoneProof and `aheadOf(a) > 0` (simulating a squash-merged branch) is NOT reopened by `auditStaleDone` and IS eligible for `auditLandedSurvivors`'s reap; the existing non-proof cases (verified behavior above) are unchanged.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/worktree*.test.ts` — `addWorktree`'s new `startPoint` param: when given, `worktree add -b <branch> <dir> <startPoint>` is the exact git invocation (assert via the injectable `GitRunner`); when omitted, behavior is byte-identical to today (regression guard on the no-startPoint path).
- `bun run check`

## Resolution

Closed 2026-07-04 via commit fc05393 (+1bfae45 review fixes) on branch worktree-research-direct-vs-glance. 5-point per-repo probe (slug, gh repo view, push dry-run, branch==default, ancestry), src/gh.ts wrapper, addWorktree startPoint, origin-aware aheadOfBase swapped into all consumers, DoneProof-first observer/reaper.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).
