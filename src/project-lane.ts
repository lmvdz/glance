/**
 * The project lane — the durable project registry, the workspace projection, and the
 * session-scoped ("ephemeral") registration lifecycle — extracted from SquadManager (concern 04
 * of plans/deepen-modules, island #3). The lane OWNS the registry and the ephemeral-marker
 * sidecar; the fleet is visible only through three read thunks on the deps port
 * (`agentSummaries` for the workspace projection, `liveRepos` for the two guards that must never
 * un-register a repo out from under a live agent, `featureRepos` for feature counts) — no
 * AgentRecord or feature object ever crosses the seam.
 *
 * Unlike FeedbackLane/CapabilityLane this lane loads state at CONSTRUCTION (registry file +
 * ephemeral sidecar), so the manager constructs it in its constructor after `stateDir` is
 * assigned — not as a field initializer. Every incident annotation moved with its code: the
 * repo-root canonicalization (grok-4.5 finding), the state-dir tenancy guard (gpt-5.6-sol
 * finding), the ephemeral restart leak, and the two-terminal release race (review finding #3).
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRepoPath, openProjectRegistry, readEphemeralProjects, writeEphemeralProjects, type ProjectRegistry } from "./project-registry.ts";
import { resolveStateDir } from "./state-dir.ts";
import type { AgentStatus, ProjectDTO } from "./types.ts";
import { repoRoot, worktreeBase } from "./worktree.ts";

/** The per-agent slice the workspace projection needs — kept structural so AgentRecord stays
 *  inside the manager. */
export interface ProjectAgentSummary {
	repo: string;
	status: AgentStatus;
	pendingCount: number;
	lastActivity: number;
}

export interface ProjectLaneDeps {
	stateDir: string;
	log(level: "info" | "warn", msg: string): void;
	/** Registration changed — persist + notify (the manager's emitFeaturesChanged). */
	changed(): void;
	/** Live roster projection for projects(). */
	agentSummaries(): ProjectAgentSummary[];
	/** Normalized repo paths with at least one live agent — the never-unregister-under-a-live-agent guards. */
	liveRepos(): Set<string>;
	/** Repo of every persisted/derived feature (one entry per feature). */
	featureRepos(): string[];
}

export class ProjectLane {
	private readonly registry: ProjectRegistry;
	/**
	 * Repos registered only for the lifetime of a `glance here` session (daily-onramp 02). Persisted as
	 * a sidecar (`ephemeral-projects.json`, loaded here) BECAUSE the registration it must undo is
	 * durable: the first cut kept this set in-memory only, so a daemon restart mid-session lost the
	 * marker while the `projects.json` row survived — every restart silently promoted a session-scoped
	 * registration to a permanent, admin-gated one (fail-open; blind-review finding). `start()` calls
	 * `reconcileAtBoot` against the restored roster: a session that survived the restart keeps its
	 * marker for the ordinary end-of-session hooks; a session that died with the old daemon is reaped
	 * at boot. Keys are the canonical repo roots `register` returns — the same key `projects()`
	 * groups by.
	 */
	private readonly ephemeral: Set<string>;

	constructor(private readonly deps: ProjectLaneDeps) {
		this.registry = openProjectRegistry(deps.stateDir);
		this.ephemeral = readEphemeralProjects(deps.stateDir);
	}

	/** The workspace projection: registered + feature-bearing + agent-bearing repos, merged. */
	projects(): ProjectDTO[] {
		const byRepo = new Map<string, ProjectDTO>();
		const ensure = (repo: string): ProjectDTO => {
			const key = normalizeRepoPath(repo);
			let p = byRepo.get(key);
			if (!p) {
				p = { id: key, name: path.basename(key) || key, repo: key, agentCount: 0, statusCounts: {}, pendingCount: 0, lastActivity: 0, featureCount: 0, registered: false };
				byRepo.set(key, p);
			}
			return p;
		};

		for (const repo of this.registry.list()) ensure(repo).registered = true;
		for (const repo of this.deps.featureRepos()) if (repo) ensure(repo).featureCount++;
		for (const a of this.deps.agentSummaries()) {
			const p = ensure(a.repo);
			p.agentCount++;
			p.statusCounts[a.status] = (p.statusCounts[a.status] ?? 0) + 1;
			p.pendingCount += a.pendingCount;
			p.lastActivity = Math.max(p.lastActivity, a.lastActivity);
		}
		// Busiest first, then a stable alphabetical tail so idle registered projects don't shuffle.
		return [...byRepo.values()].sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
	}

	/**
	 * Register a repo as a project. Validated, not trusted: an absolute path to a real git worktree.
	 *
	 * This path is where the daemon will later create worktrees and spawn agents, so a relative path is
	 * REFUSED rather than resolved against the daemon's cwd — that cwd is an accident of how the
	 * operator launched it (this daemon runs from `~/lunarpup` while its code lives elsewhere), and
	 * silently resolving against it is how you register the wrong tree.
	 */
	async register(repo: string, opts: { promoteEphemeral?: boolean } = {}): Promise<{ ok: true; repo: string; added: boolean } | { ok: false; reason: string }> {
		const raw = normalizeRepoPath(repo ?? "");
		if (!raw) return { ok: false, reason: "repo is required" };
		if (!path.isAbsolute(raw)) return { ok: false, reason: `repo must be an absolute path (got "${raw}")` };
		if (!existsSync(raw)) return { ok: false, reason: `no such directory: ${raw}` };

		// Canonicalize to the repo ROOT, through symlinks. `isGitRepo` is true for any directory INSIDE a
		// repo (it shells `rev-parse --show-toplevel` and only falls back to a `.git` probe), so registering
		// `/repo/src` — or a symlink to `/repo` — used to mint a project whose id matched no agent's
		// `dto.repo` and no feature's `repo`: the workspace showed two rows for one repository and the
		// task↔project join missed. Found by cross-lineage review (grok-4.5).
		let root: string;
		try {
			root = normalizeRepoPath(await repoRoot(await fs.realpath(raw)));
		} catch {
			return { ok: false, reason: `not a git repository: ${raw}` };
		}

		// Never register anything inside glance's OWN data directory.
		//
		// A glance worktree is a git repo too, and its lifetime belongs to an agent, not the operator. But
		// the sharper reason is tenancy: per-org managers put their worktrees under
		// `<stateRoot>/orgs/<orgId>/worktrees` (manager-registry.ts), while `worktreeBase()` only names the
		// ROOT manager's `<stateRoot>/worktrees`. Guarding the latter alone let one org's admin register
		// ANOTHER org's managed worktree — and registration widens the viewer-readable `/api/graph*`
		// allowlist (`resolveGraphRepo`), whose `/api/graph/commit` returns source diffs. That is a
		// cross-tenant read, not a role bypass. Refusing the whole state root closes every variant at once:
		// orgs/*/worktrees, the root worktrees dir, proof/, receipts/, and anything added later.
		// Found by cross-lineage review (gpt-5.6-sol).
		const forbidden = [resolveStateDir(), worktreeBase(), this.deps.stateDir].map(normalizeRepoPath);
		const inside = forbidden.find((base) => base.length > 0 && (root === base || root.startsWith(`${base}${path.sep}`)));
		if (inside) {
			return { ok: false, reason: `${root} is inside glance's own state directory (${inside}) — register the source repository instead` };
		}

		const outcome = this.registry.add(root);
		if (outcome === "error") return { ok: false, reason: `could not persist the project registry — ${root} was NOT added` };
		if (outcome === "added") this.deps.log("info", `project registered: ${root}`);
		// An explicit durable registration of a repo a live `glance here` session registered only for its
		// lifetime is a PROMOTION ("keep it") — clear the session-scoped marker so end-of-session release
		// no longer silently un-registers what the operator just asked to keep. Idempotent add ⇒ this is the
		// exact case `add()` returns "exists" for. clearEphemeralMarker is a no-op when the repo was never
		// ephemeral, so it's safe unconditionally on this explicit path. registerEphemeral's own delegated
		// call passes no opts, so a fresh session registration never promotes itself.
		if (opts.promoteEphemeral) this.clearMarker(root);
		this.deps.changed();
		return { ok: true, repo: root, added: outcome === "added" };
	}

	/** Un-register a repo. Deletes NOTHING on disk; a repo with live agents or features keeps listing. */
	unregister(repo: string): { ok: true; repo: string; removed: boolean } | { ok: false; reason: string } {
		const key = normalizeRepoPath(repo ?? "");
		const outcome = this.registry.delete(key);
		if (outcome === "error") return { ok: false, reason: `could not persist the project registry — ${key} was NOT removed` };
		if (outcome === "removed") this.deps.log("info", `project un-registered: ${key}`);
		this.deps.changed();
		return { ok: true, repo: key, removed: outcome === "removed" };
	}

	/** Drop a repo's session-scoped marker (promote / release) and persist the shrunken sidecar —
	 *  public because the manager's promote path calls it directly ("keep it": the marker goes, the
	 *  registration stays durable; both the first call and the idempotent re-promote clear it). A
	 *  failed sidecar write here is self-healing: boot reconciliation drops markers whose repo is no
	 *  longer registered, and re-releasing an already-durable repo is a no-op by design. */
	clearMarker(repo: string): void {
		if (this.ephemeral.delete(normalizeRepoPath(repo))) {
			writeEphemeralProjects(this.deps.stateDir, this.ephemeral);
		}
	}

	/**
	 * Boot reconciliation for the reloaded ephemeral markers — the manager's start() calls this AFTER
	 * the roster is restored (reconnectLive/adoptOrphanedAgents), so it can tell surviving sessions
	 * from dead ones:
	 *   - marker whose repo still has a live agent → the session outlived the restart (concern 04);
	 *     keep the marker so the ordinary session-end hooks (release route, `remove()`) still undo it;
	 *   - marker whose repo has NO live agent → the session died with the old daemon; un-register now.
	 *     This is the restart leak the sidecar exists to close;
	 *   - marker whose repo is no longer registered at all → stale (released after a failed sidecar
	 *     write, or the operator removed the project); just drop it.
	 * A failed un-register keeps its marker so the NEXT boot retries — never drop the undo obligation
	 * on an error.
	 */
	reconcileAtBoot(): void {
		if (this.ephemeral.size === 0) return;
		const liveRepos = this.deps.liveRepos();
		let dirty = false;
		for (const repo of [...this.ephemeral]) {
			if (liveRepos.has(repo)) continue;
			if (this.registry.has(repo)) {
				const dropped = this.unregister(repo);
				if (!dropped.ok) {
					this.deps.log("warn", `could not reap ephemeral project ${repo} at boot (${dropped.reason}) — marker kept for the next attempt`);
					continue;
				}
				this.deps.log("info", `ephemeral project reaped at boot (its session did not survive the restart): ${repo}`);
			}
			this.ephemeral.delete(repo);
			dirty = true;
		}
		if (dirty) writeEphemeralProjects(this.deps.stateDir, this.ephemeral);
	}

	/** Test/observability read: is this repo's registration session-scoped right now? */
	isEphemeral(repo: string): boolean {
		return this.ephemeral.has(normalizeRepoPath(repo ?? ""));
	}

	/**
	 * Register a repo for the lifetime of a casual session: same validation and durable write as
	 * `register`, plus a marker so session end can undo it. Only a repo THIS call actually ADDED
	 * becomes ephemeral — a repo the operator had already registered durably must never be silently
	 * un-registered when a passing `glance here` session ends (`add()` is idempotent, so `added:false`
	 * is exactly that case).
	 *
	 * `ephemeral` in the return is likewise scoped to `added`, NOT to whether the repo is currently
	 * marked ephemeral (review finding #3, ephemeral release race): two `glance here` terminals on the
	 * same repo are explicitly supported (boundarySyncChains), so a SECOND session's call here sees
	 * `added:false` (the first session's marker already exists) — it must report `ephemeral:false` too,
	 * even though the marker set reads true. Before this fix the second session was told
	 * `ephemeral:true`, so its own ordinary exit (or a failed-create rollback) would call
	 * `releaseEphemeral` believing it owned the registration, un-registering the FIRST session's repo —
	 * and clearing its marker — while that session was still live and chatting. Only the session that
	 * actually created the marker is now ever told it owns the release. `releaseEphemeral` carries its
	 * own defense-in-depth guard for the case where a caller releases anyway (or a live agent from ANY
	 * session still depends on the repo).
	 */
	async registerEphemeral(repo: string): Promise<{ ok: true; repo: string; added: boolean; ephemeral: boolean } | { ok: false; reason: string }> {
		const result = await this.register(repo);
		if (!result.ok) return result;
		if (result.added) {
			this.ephemeral.add(result.repo);
			// The registration this marker must undo is already durable — a marker that exists only in
			// memory would not survive a restart, silently promoting the session-scoped registration to
			// permanent. Fail CLOSED: no durable marker ⇒ no ephemeral registration at all.
			if (!writeEphemeralProjects(this.deps.stateDir, this.ephemeral)) {
				this.ephemeral.delete(result.repo);
				const rollback = this.unregister(result.repo);
				return {
					ok: false,
					reason: rollback.ok
						? `could not persist the ephemeral session marker for ${result.repo} — the registration was rolled back`
						: `could not persist the ephemeral session marker for ${result.repo} AND the rollback failed (${rollback.reason}) — the repo is now durably registered; un-register it explicitly`,
				};
			}
		}
		// `result.added`, not the marker set — see the doc comment above.
		return { ...result, ephemeral: result.added };
	}

	/**
	 * Undo an ephemeral registration on ordinary session end (REPL exit, or the daemon's own removal
	 * path — see the manager's `remove()`). No-op for repos that were never session-scoped, so callers
	 * can fire it unconditionally. Deletes nothing on disk, per `unregister`'s own contract.
	 *
	 * Guarded the same way `remove()`'s own daemon-side cleanup is (review finding #3): a repo stays
	 * registered as long as ANY live agent still references it, regardless of which session's marker
	 * this call is scoped to. `registerEphemeral` now only reports `ephemeral:true` to the session
	 * that actually created the marker, which closes most of the race — but this guard is the belt: it
	 * also protects the two callers that never had `remove()`'s own last-agent check (server.ts's
	 * `/api/console/release` route, and the `/api/console` failed-create rollback), so even a caller
	 * that mistakenly believes it owns the release can never un-register a repo out from under another
	 * session's still-live agent.
	 */
	releaseEphemeral(repo: string): { ok: boolean; repo: string; released: boolean; reason?: string } {
		const key = normalizeRepoPath(repo ?? "");
		if (!this.ephemeral.has(key)) return { ok: true, repo: key, released: false };
		if (this.deps.liveRepos().has(key)) {
			return { ok: true, repo: key, released: false };
		}
		const dropped = this.unregister(key);
		if (!dropped.ok) return { ok: false, repo: key, released: false, reason: dropped.reason };
		this.clearMarker(key);
		return { ok: true, repo: key, released: true };
	}

	/** Registered repo roots, for the manager's residual registry reads. */
	registeredRepos(): string[] {
		return this.registry.list();
	}

	/** Is this repo root durably registered right now? */
	isRegistered(repo: string): boolean {
		return this.registry.has(normalizeRepoPath(repo ?? ""));
	}
}
