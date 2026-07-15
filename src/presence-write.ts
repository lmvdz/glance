/**
 * presence-write.ts — the scope authority for the cockpit's presence/lease WRITE endpoints
 * (fleet-ide-intervention I02). A presence/lease claim mutates shared, machine-wide state that
 * `glance who` and every agent's lease-hook read, so the daemon must not let a local caller mint
 * presence for arbitrary paths. A write is allowed ONLY for a path the daemon actually manages:
 * a registered project root, or a live agent's own repo/worktree. Pure + tested.
 */
import * as path from "node:path";

/** The daemon-known workspace paths a write may target, gathered from the manager. */
export interface KnownWorkspaces {
	/** Registered project roots (ProjectDTO.repo). */
	projects: string[];
	/** Live agents' repo + worktree paths (AgentDTO.repo, AgentDTO.worktree). */
	agentPaths: string[];
}

/** A presence claim `id` becomes a FILENAME in the ttl-registry (`reg.readOne/remove` → path.join),
 *  and it is client-supplied on both the POST body and the DELETE query. Restrict it to a safe
 *  charset + length so a crafted `id` (e.g. `../../etc/x`) can't traverse out of the presence bucket
 *  — the same defense B03 applies to session ids. Server-minted ids (`<pid>-<b36>-<b36>`) pass. */
export function isSafePresenceId(id: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Identity namespaces reserved for the daemon's OWN sessions (agents claim presence/leases as
 *  `omp:<id>` / `squad:<id>`). An HTTP write client (the cockpit) must NOT use them: a lease id is
 *  deterministic from (session, file), so a cockpit sending `session:"omp:<pid>"` would refresh or
 *  clobber that agent's own lease (codex review). The cockpit uses `glance-cockpit:<id>`. */
export function isReservedIdentity(identity: string): boolean {
	return /^(omp|squad):/i.test(identity.trim());
}

/** True when `repo` (resolved) is a project root the daemon knows, or a live agent's repo/worktree.
 *  This is the write scope gate — the read endpoints stay open, but a write must name a managed path. */
export function isDaemonWorkspace(repo: string, known: KnownWorkspaces): boolean {
	const target = path.resolve(repo);
	const allowed = new Set<string>();
	for (const p of known.projects) allowed.add(path.resolve(p));
	for (const p of known.agentPaths) allowed.add(path.resolve(p));
	return allowed.has(target);
}
