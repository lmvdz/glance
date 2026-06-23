/**
 * Dispatcher — closes the autonomous-org loop: poll Plane for open issues and
 * spawn a routed agent per new one, so work starts without anyone typing a line.
 * Each issue flows through the intake router (in `create`), so the OS picks the
 * process (verify loop / plan+approval / fan-out) per issue.
 *
 * Opt-in (the daemon never auto-spawns unless enabled) and bounded by `maxActive`
 * so a backlog can't trigger a spawn storm. Every external edge is injected, so
 * the selection + concurrency logic is tested without Plane, tokens, or a clock.
 */

import type { IssueRef } from "./types.ts";

export interface DispatchDeps {
	/** Repos wired to Plane (poll targets). */
	repos: () => string[];
	/** Open issues for a repo; `null` ⇒ Plane not configured / unreachable (skip). */
	listIssues: (repo: string) => Promise<IssueRef[] | null>;
	/** Spawn a routed agent for an issue (→ manager.create with autoRoute). */
	spawn: (repo: string, issue: IssueRef) => Promise<void>;
	/** Issue ids already represented in the roster (any state) — never double-dispatch. */
	claimed: () => Set<string>;
	/** Count of dispatched agents currently busy — caps concurrency. */
	activeCount: () => number;
	log: (msg: string) => void;
	/** Max concurrent dispatched agents. Default 3. */
	maxActive?: number;
	/** Total live (non-terminal) agents across the whole roster — bounds dispatch by the global WIP cap. */
	liveCount?: () => number;
	/** Global live-agent WIP cap (OMP_SQUAD_MAX_WIP). When set, dispatch never pushes live agents past it. */
	maxWip?: number;
}

export class Dispatcher {
	private readonly deps: DispatchDeps;
	private readonly maxActive: number;
	/** Issue ids dispatched this session — don't re-spawn a finished/failed one. */
	private readonly dispatched = new Set<string>();
	/** Issue ids deferred because a blocker is still open — tracked only to log the deferral once per episode. */
	private readonly blockedLogged = new Set<string>();
	/** Issue ids skipped for human-review / no-auto-land — tracked only to log the skip once per episode. */
	private readonly skipLogged = new Set<string>();
	private timer?: Timer;
	private running = false;

	constructor(deps: DispatchDeps) {
		this.deps = deps;
		this.maxActive = deps.maxActive ?? 3;
	}

	/** One poll: spawn routed agents for new open issues, bounded by `maxActive`. Returns the number spawned. */
	async tick(): Promise<number> {
		if (this.running) return 0; // never overlap polls
		this.running = true;
		let spawned = 0;
		try {
			const claimed = this.deps.claimed();
			let budget = this.maxActive - this.deps.activeCount();
			for (const repo of this.deps.repos()) {
				if (this.atGlobalCap()) break; // global WIP ceiling reached — leave remaining issues for a later tick
				if (budget <= 0) break;
				const issues = await this.deps.listIssues(repo);
				if (!issues) continue;
				// Issue ids still open in THIS project this tick. A blocker absent here is completed/cancelled
				// (or gone), so it no longer blocks. Cross-project blockers aren't visible — see ceiling note.
				const openIds = new Set(issues.map((i) => i.id));
				for (const issue of issues) {
					if (budget <= 0) break;
					if (this.atGlobalCap()) break; // recheck per spawn: each spawned agent counts toward the global cap
					if (claimed.has(issue.id) || this.dispatched.has(issue.id)) continue;
					// Human-review / do-NOT-auto-land: stays visible in the UI's issue list but never auto-dispatched.
					// Not added to `dispatched`, logged once like the blocked_by deferral.
					if (issue.noAutoDispatch) {
						if (!this.skipLogged.has(issue.id)) {
							this.skipLogged.add(issue.id);
							this.deps.log(`skip ${issue.identifier ?? issue.id} — human-review / do-not-auto-land`);
						}
						continue;
					}
					// Dependency gate: defer while any blocked_by issue is still open. Not added to `dispatched`,
					// so it's reconsidered each tick and dispatches once its blockers land/close.
					const blockers = issue.blockedBy?.filter((b) => openIds.has(b)) ?? [];
					if (blockers.length > 0) {
						if (!this.blockedLogged.has(issue.id)) {
							this.blockedLogged.add(issue.id);
							this.deps.log(`defer ${issue.identifier ?? issue.id} — blocked by ${blockers.length} open issue(s)`);
						}
						continue;
					}
					this.dispatched.add(issue.id);
					this.blockedLogged.delete(issue.id); // dispatching ⇒ no longer deferred
					this.deps.log(`dispatch ${issue.identifier ?? issue.id} — ${issue.name}`);
					try {
						await this.deps.spawn(repo, issue);
						spawned++;
						budget--;
					} catch (err) {
						this.deps.log(`dispatch failed for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
		} finally {
			this.running = false;
		}
		return spawned;
	}

	/** True when the roster is at/over the global live-agent WIP cap, so no further spawn should be attempted. */
	private atGlobalCap(): boolean {
		return this.deps.maxWip !== undefined && (this.deps.liveCount?.() ?? 0) >= this.deps.maxWip;
	}

	start(intervalMs: number): void {
		if (this.timer) return;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}
