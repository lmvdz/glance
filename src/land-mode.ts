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
	return Number(process.env.OMP_SQUAD_LAND_MODE_TTL_MS) || 5 * 60_000;
}

const cache = new Map<string, { resolved: ResolvedLandMode; at: number }>();

/** Resolve `repo`'s landing mode. `OMP_SQUAD_LAND_MODE=local`/`=pr` bypass the probe entirely
 *  (pr forced without probing means no known default branch — `aheadOfBase` falls back to local
 *  arithmetic in that case, same as if the probe hadn't run). Cached per-repo for `ttlMs()`. */
export async function resolveLandMode(repo: string): Promise<ResolvedLandMode> {
	const configured = (process.env.OMP_SQUAD_LAND_MODE ?? "auto") as LandMode;
	if (configured === "local") return { mode: "local", reason: "OMP_SQUAD_LAND_MODE=local" };
	if (configured === "pr") return { mode: "pr", reason: "OMP_SQUAD_LAND_MODE=pr (forced, probes skipped)" };

	const cached = cache.get(repo);
	if (cached && Date.now() - cached.at < ttlMs()) return cached.resolved;

	const resolved = await probe(repo);
	cache.set(repo, { resolved, at: Date.now() });
	return resolved;
}

async function probe(repo: string): Promise<ResolvedLandMode> {
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
	const defaultBranch = process.env.OMP_SQUAD_PR_BASE || view.defaultBranchRef.name;

	// 3. git push --dry-run origin <default> — catches per-repo transport failures (gh auth ≠ push works).
	const dryRun = await hardenedGit(["push", "--dry-run", "origin", defaultBranch], { cwd: repo });
	if (dryRun.code !== 0) return { mode: "local", reason: `git push --dry-run origin ${defaultBranch} failed: ${dryRun.stderr.trim()}` };

	// 4. current local branch == remote default — a deliberate non-default checkout always wins.
	const current = await hardenedGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
	const currentBranch = current.stdout.trim();
	if (currentBranch !== defaultBranch) return { mode: "local", reason: `checked-out branch ${currentBranch} != remote default ${defaultBranch} — deliberate operator checkout wins` };

	// 5. local default is ancestor of freshly-fetched origin/<default> — divergence forces local + loud log.
	await hardenedGit(["fetch", "origin", defaultBranch], { cwd: repo }).catch(() => undefined);
	const localSha = (await hardenedGit(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
	const ancestor = await isAncestor(localSha, `origin/${defaultBranch}`, repo);
	if (!ancestor) return { mode: "local", reason: `local ${defaultBranch} is NOT an ancestor of origin/${defaultBranch} — diverged, forcing local mode until reconciled (see boot warning)` };

	return { mode: "pr", defaultBranch, reason: `all 5 probes passed (slug ${slug}, default ${defaultBranch})` };
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
 *  local mode: `HEAD`). 0 ⇒ fully landed/empty; -1 ⇒ couldn't determine. The ONE replacement for every
 *  `rev-list <base>..<branch>`-style computation in the codebase. */
export async function aheadOfBase(opts: { repo: string; branch: string; cwd?: string }): Promise<number> {
	const cwd = opts.cwd ?? opts.repo;
	const mode = await resolveLandMode(opts.repo);
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
