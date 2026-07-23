/**
 * Land-mode probe — per-repo, auto-probed resolution of local-vs-PR landing mode.
 *
 * Every individual failure mode (host-aliased origin, diverged repo, no push capability,
 * non-default checkout) independently forces `local` with a loud, logged reason — never a
 * silent wrong guess. `resolveLandMode` NEVER returns "auto": it always collapses to one of
 * the two concrete modes.
 *
 * Also the home of `aheadOfBase`, the ONE origin-aware "how far ahead" primitive: PR mode counts
 * against the fetched `origin/<default>`, local mode against `HEAD` — replacing every
 * `rev-list HEAD..branch`-style computation scattered across the codebase so squash/rebase merges
 * (which make local arithmetic permanently wrong) don't silently reopen or reap the wrong thing.
 */

import { envInt } from "./config.ts";
import { hardenedGit } from "./git-harden.ts";
import { isAncestor } from "./done-proof.ts";
import { ghJson } from "./gh.ts";
import { repoIdentity } from "./repo-identity.ts";

export type LandMode = "auto" | "pr" | "local";

export interface ResolvedLandMode {
	/** Resolved, never "auto" — auto always collapses to one of these. */
	mode: "pr" | "local";
	/** gh-reported default branch (pr mode only). */
	defaultBranch?: string;
	/** Which probe passed/failed — always logged, so an operator sees why without digging. */
	reason: string;
}

/** Cache TTL for a resolved mode, ms. Overridable for tests; default 5 minutes. */
function ttlMs(): number {
	return envInt("OMP_SQUAD_LAND_MODE_TTL_MS", 5 * 60_000);
}

const cache = new Map<string, { resolved: ResolvedLandMode; at: number }>();

/**
 * Explicit inputs that bypass the process-global env vars `resolveLandMode` otherwise reads.
 *
 * These exist because `OMP_SQUAD_LAND_MODE` / `OMP_SQUAD_PR_BASE` are read off `process.env` — a
 * single mutable global shared across every test in Bun's one-process runner. A test (or any caller)
 * that sets one of those envs and then does awaited work HOLDS the global live across the await, so a
 * concurrently-running sibling file that reads the ambient value mid-await sees the wrong mode — the
 * exact cross-file leak that made `land-mode.test.ts`'s pr-expecting probes flaky under the full
 * suite (a sibling's `OMP_SQUAD_LAND_MODE=local` bled in). Passing the mode explicitly here severs
 * that channel entirely: the value comes from the argument, never the global. Production callers pass
 * nothing and behave exactly as before (env is still the source of truth).
 */
export interface LandModeOverrides {
	/** Explicit land mode — takes precedence over `process.env.OMP_SQUAD_LAND_MODE`. */
	landMode?: LandMode;
	/** Explicit PR base branch — takes precedence over `process.env.OMP_SQUAD_PR_BASE`. */
	prBase?: string;
}

/** Resolve `repo`'s landing mode. `OMP_SQUAD_LAND_MODE=local`/`=pr` bypass the probe entirely
 *  (pr forced without probing means no known default branch — `aheadOfBase` falls back to local
 *  arithmetic in that case, same as if the probe hadn't run). Cached per-repo for `ttlMs()`.
 *  `overrides` lets a caller supply the mode/PR-base explicitly instead of via `process.env` — see
 *  {@link LandModeOverrides} for why (concurrency-safe, env-leak-immune). */
export async function resolveLandMode(repo: string, overrides?: LandModeOverrides): Promise<ResolvedLandMode> {
	const configured = (overrides?.landMode ?? process.env.OMP_SQUAD_LAND_MODE ?? "auto") as LandMode;
	const prBase = overrides ? overrides.prBase : process.env.OMP_SQUAD_PR_BASE;
	if (configured === "local") return { mode: "local", reason: "OMP_SQUAD_LAND_MODE=local" };
	if (configured === "pr") {
		// Forcing pr mode still needs a defaultBranch — without one, landBranch/floatPrOnLandReady/
		// retryPushFloat/the dispatch startPoint all require `mode.defaultBranch` to do anything in PR
		// mode, so an unresolved default used to make EVERY one of them silently fall through to local
		// behavior despite the operator explicitly forcing PR mode. The 5-point convergence probe is
		// skipped (that's what "forced" means), but the branch NAME itself is still resolved best-effort.
		const defaultBranch = await resolveDefaultBranchBestEffort(repo, prBase);
		return defaultBranch
			? { mode: "pr", defaultBranch, reason: `OMP_SQUAD_LAND_MODE=pr (forced, convergence probes skipped); default branch resolved: ${defaultBranch}` }
			: { mode: "pr", reason: "OMP_SQUAD_LAND_MODE=pr (forced) but no default branch could be resolved (gh repo view, origin/HEAD symref, and git ls-remote all failed) — the caller must refuse to land rather than silently falling back to local" };
	}

	const cached = cache.get(repo);
	if (cached && Date.now() - cached.at < ttlMs()) return cached.resolved;

	const resolved = await probe(repo, prBase);
	cache.set(repo, { resolved, at: Date.now() });
	return resolved;
}

/** A ref that never legitimately exists on any remote — probe 3 pushes `HEAD:` to it so the write
 *  probe is always a "create" (no fast-forward comparison possible), never a conflict with real work. */
const PUSH_PROBE_REF = "refs/heads/squad/push-probe";

/**
 * Best-effort default-branch resolution for FORCED pr mode (the convergence probe is skipped, but a
 * defaultBranch is still required by every PR-mode consumer). Three independent sources, cheapest/
 * most-authoritative first; `OMP_SQUAD_PR_BASE` overrides all of them, same as the probed path.
 * Never throws — an unexpected failure in any step just falls through to the next.
 */
async function resolveDefaultBranchBestEffort(repo: string, prBase?: string): Promise<string | undefined> {
	try {
		if (prBase) return prBase;

		// 1. gh repo view <slug> --json defaultBranchRef — the same authoritative source the probed
		//    path uses; slug-addressed so a host-aliased origin still resolves.
		const identity = repoIdentity(repo);
		const parts = identity.split("/");
		if (parts.length >= 3) {
			const slug = parts.slice(-2).join("/");
			const view = await ghJson<{ defaultBranchRef: { name: string } }>(["repo", "view", slug, "--json", "defaultBranchRef"], repo);
			if (view?.defaultBranchRef?.name) return view.defaultBranchRef.name;
		}

		// 2. git symbolic-ref refs/remotes/origin/HEAD — set by `git clone` (or `git remote set-head
		//    origin -a`); no gh call or network round-trip needed when it's already recorded locally.
		const symref = await hardenedGit(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repo });
		const symrefName = symref.code === 0 ? symref.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : "";
		if (symrefName) return symrefName;

		// 3. git ls-remote --symref origin HEAD — asks the remote directly; needs neither gh nor any
		//    local remote-tracking state.
		const lsRemote = await hardenedGit(["ls-remote", "--symref", "origin", "HEAD"], { cwd: repo });
		const match = lsRemote.code === 0 ? /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(lsRemote.stdout) : null;
		if (match?.[1]) return match[1];

		// 4. Every probe failed — "main" is the overwhelmingly common default, and a wrong guess still
		//    fails LOUDLY downstream (a fetch/push/`gh pr create` against a nonexistent branch), never
		//    silently local-merging — the one invariant this fallback chain exists to protect.
		return "main";
	} catch {
		return undefined;
	}
}

async function probe(repo: string, prBase?: string): Promise<ResolvedLandMode> {
	// 1. owner/repo slug from origin — repoIdentity()/normalizeGitUrl() (src/repo-identity.ts) return
	//    "<host>/<owner>/<repo>" and do NOT collapse a host alias (e.g. git@github.com-personal:owner/repo.git
	//    normalizes to "github.com-personal/owner/repo", not "github.com/owner/repo") — this is exactly why
	//    a URL-host check would fail on an aliased origin and why gh must be addressed by slug, not host.
	const identity = repoIdentity(repo); // "host/owner/repo" (or "name:<basename>" with no origin)
	const parts = identity.split("/");
	if (parts.length < 3) return { mode: "local", reason: `no parseable owner/repo from origin (${identity})` };
	const slug = parts.slice(-2).join("/"); // "owner/repo"

	// 2. gh repo view <slug> --json defaultBranchRef
	const view = await ghJson<{ defaultBranchRef: { name: string } }>(["repo", "view", slug, "--json", "defaultBranchRef"], repo);
	if (!view?.defaultBranchRef?.name) return { mode: "local", reason: `gh repo view ${slug} failed or has no default branch` };
	const defaultBranch = prBase || view.defaultBranchRef.name;

	// 3. Write-capability probe — catches per-repo transport/auth failures (gh auth ≠ push works)
	//    WITHOUT non-fast-forward semantics. Probing `git push --dry-run origin <default>` directly
	//    rejects as non-fast-forward whenever the local default is merely BEHIND origin — the NORMAL
	//    PR-mode state (merges happen on GitHub, not locally) — which would silently force local mode
	//    on every healthy PR-mode repo the moment the checkout drifts behind (and since aheadOfBase's
	//    mode !== "pr" then skips ff-heal too, it can never self-correct). `PUSH_PROBE_REF` doesn't
	//    exist on the remote, so pushing HEAD to it is always a create — `--dry-run` never performs it,
	//    but still exercises the exact same auth/transport path, with no fast-forward trap.
	const dryRun = await hardenedGit(["push", "--dry-run", "origin", `HEAD:${PUSH_PROBE_REF}`], { cwd: repo });
	if (dryRun.code !== 0) return { mode: "local", reason: `git push --dry-run origin HEAD:${PUSH_PROBE_REF} failed: ${dryRun.stderr.trim()}` };

	// 4. Which branch the operator has checked out is READ (for the reason string) but never gates the
	//    mode. A PR-mode unit forks from `origin/<default>` into its own worktree and lands by pushing
	//    that worktree's branch and merging the PR on the remote: the shared checkout is never merged
	//    into, never reset, never even read. The old rule inverted this — "a deliberate non-default
	//    checkout always wins" forced LOCAL mode, whose `landAgent` then refuses on `land.ts`'s
	//    dirty-checkout guard, `retryable: true`, so it never escalates to a human. The two conditions
	//    are individually sane and jointly fatal: an operator working in the repo (non-default branch,
	//    dirty tree) is exactly when glance is useful, and exactly when it silently could not land.
	//    Measured on this repo before the fix: 1381 of 1686 recorded land attempts (82%) died on that
	//    guard, and no autonomously-dispatched unit had ever merged. A non-default checkout is an
	//    argument FOR pr mode — never touch the tree the human is standing on — not against it.
	//    `OMP_SQUAD_LAND_MODE=local` remains the explicit opt-out for repos with no usable remote.
	const current = await hardenedGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
	const currentBranch = current.stdout.trim();

	// 5. The LOCAL DEFAULT BRANCH must not have diverged from freshly-fetched origin/<default>: an
	//    unpushed local commit there would be silently stranded by merges that now happen on the
	//    remote. Resolved via `refs/heads/<default>`, NOT `HEAD` — the two were the same ref only
	//    because probe 4 used to guarantee it, so reading HEAD here was load-bearing on an invariant
	//    that no longer holds (on a feature branch HEAD is never an ancestor of origin/<default>, which
	//    re-forced local mode independently of probe 4). A repo with no local `<default>` ref at all
	//    (cloned straight onto a branch) has nothing to strand → pr.
	//
	//    The fetch must SUCCEED. `hardenedGit` reports failure through a nonzero `code` and never
	//    rejects, so the old `.catch(() => undefined)` was decorative: a failed fetch fell straight
	//    through to an ancestor test against a STALE `origin/<default>`, which trivially passes and
	//    resolves pr. The daemon would then gate a scratch merge against the stale base while GitHub
	//    merges the PR into the real (newer) one — a combination nothing ever tested. Probes 2 and 3
	//    already proved gh and push work, so a fetch failure here is genuinely anomalous: fail closed.
	const fetched = await hardenedGit(["fetch", "origin", defaultBranch], { cwd: repo }).catch(() => ({ code: 1, stdout: "", stderr: "fetch threw" }));
	if (fetched.code !== 0) return { mode: "local", reason: `could not fetch origin/${defaultBranch} (${fetched.stderr.trim() || `exit ${fetched.code}`}) — refusing to resolve pr mode against a stale base` };
	const localDefault = await hardenedGit(["rev-parse", "--verify", `refs/heads/${defaultBranch}`], { cwd: repo });
	if (localDefault.code === 0) {
		const ancestor = await isAncestor(localDefault.stdout.trim(), `origin/${defaultBranch}`, repo);
		if (!ancestor) return { mode: "local", reason: `local ${defaultBranch} is NOT an ancestor of origin/${defaultBranch} — diverged, forcing local mode until reconciled (see the operator runbook logged at boot for this repo)` };
	}

	const standing = currentBranch === defaultBranch ? "" : `; operator on ${currentBranch}, units fork from origin/${defaultBranch}`;
	return { mode: "pr", defaultBranch, reason: `all 5 probes passed (slug ${slug}, default ${defaultBranch}${standing})` };
}

// ── aheadOfBase — ONE origin-aware "ahead" primitive for every consumer ─────────────────────────

/** Throttle `git fetch origin <default>` to at most once per `ttlMs()` window per repo — an
 *  `aheadOfBase` call on every Observer tick/reaper pass must not hammer the remote. */
const lastFetch = new Map<string, number>();
async function throttledFetch(repo: string, defaultBranch: string): Promise<void> {
	const last = lastFetch.get(repo) ?? 0;
	if (Date.now() - last < ttlMs()) return;
	lastFetch.set(repo, Date.now());
	await hardenedGit(["fetch", "origin", defaultBranch], { cwd: repo }).catch(() => undefined);
}

/** Commits on `branch` not reachable from the resolved base (PR mode: fetched `origin/<default>`;
 *  local mode: `HEAD`). 0 ⇒ fully landed/empty; **-1 ⇒ couldn't determine** (the underlying `git
 *  rev-list` failed — a transient fault, not a measurement). The ONE replacement for every
 *  `rev-list <base>..<branch>`-style computation in the codebase.
 *
 *  -1 is an in-band error sentinel on a numeric channel: a caller that does a bare `> 0` (or compares
 *  against a specific positive count) silently reads "couldn't determine" as "definitely 0 or
 *  negative", which for every "does this branch have unlanded work?" consumer means "no work" — a git
 *  fault then reads as "nothing to land" and the caller moves on as if it were clean. That is exactly
 *  the interlock shape this codebase has been bitten by before (see aheadOfMain's callers in
 *  squad-manager.ts and the orchestrator's `agentHasWork` skip). Every WORK-GATING consumer (does this
 *  branch have something to land/resume?) MUST branch on the unknown case explicitly via the
 *  `aheadUnknown` guard below rather than a bare `> 0`/`< 0`/`=== -1` — a false negative there silently
 *  drops real work.
 *
 *  This does NOT ban a bare `=== 0` everywhere: an EXACT-equality test against zero is fail-safe by
 *  construction, because -1 (or any nonzero count) never collapses into it — it stays "not merged"
 *  without the guard doing any work. `worktree-reaper.ts`'s `WorktreeInfo.aheadOfBase` is the sanctioned
 *  instance of this: `selectReapable`'s `w.aheadOfBase === 0` reads an unknown git fault as "not merged"
 *  (the correct, conservative direction for a DESTRUCTIVE decision — reaping a worktree whose ahead-count
 *  is actually unknown would be the dangerous mistake), so it deliberately skips the named guard and
 *  compares the raw number directly; do not "fix" it to route through `aheadUnknown`, that would be a
 *  no-op at best. The guard exists for the OTHER polarity — `> 0`-shaped tests, where -1 quietly reads as
 *  false — and for `observer.ts`'s `auditStaleDone`/`auditLandedSurvivors`, which branch on `aheadUnknown`
 *  explicitly so the "unknown vs. genuinely landed" distinction stays legible even though their net
 *  effect (skip) is similar to the reaper's exact-equality shortcut. `aheadUnknown` also documents what
 *  each direction of "unknown" should mean: assume-work-exists for anything gating a land/resume
 *  decision, not-merged for anything gating a destructive/cleanup decision (the worktree reaper).
 */
export async function aheadOfBase(opts: { repo: string; branch: string; cwd?: string; overrides?: LandModeOverrides }): Promise<number> {
	const cwd = opts.cwd ?? opts.repo;
	const mode = await resolveLandMode(opts.repo, opts.overrides);
	if (mode.mode === "pr" && mode.defaultBranch) {
		await throttledFetch(opts.repo, mode.defaultBranch);
		const r = await hardenedGit(["rev-list", "--count", `origin/${mode.defaultBranch}..${opts.branch}`], { cwd });
		return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1;
	}
	// Local mode measures against the repo's OWN checked-out HEAD, never `opts.cwd` — a caller
	// commonly passes the agent's worktree here, and inside that worktree HEAD *is* `opts.branch`,
	// which makes `HEAD..branch` permanently 0 regardless of how many commits are actually unlanded.
	// Branch refs are shared across worktrees of the same repo, so running this at `opts.repo`
	// costs nothing and restores the pre-refactor `-C <main checkout>` semantics.
	const r = await hardenedGit(["rev-list", "--count", `HEAD..${opts.branch}`], { cwd: opts.repo });
	return r.code === 0 ? Number(r.stdout.trim()) || 0 : -1;
}

/** Named guard for `aheadOfBase`'s -1 sentinel — the one and only correct way to test for "couldn't
 *  determine". Never compare the raw number against `-1`/`< 0` inline; route through this so the
 *  intent ("this is the unknown case, not a real count") is legible at every call site and grep-able
 *  in one place. */
export function aheadUnknown(n: number): boolean {
	return n < 0;
}
