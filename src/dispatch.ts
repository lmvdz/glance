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
}

export class Dispatcher {
	private readonly deps: DispatchDeps;
	private readonly maxActive: number;
	/** Issue ids dispatched this session — don't re-spawn a finished/failed one. */
	private readonly dispatched = new Set<string>();
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
				if (budget <= 0) break;
				const issues = await this.deps.listIssues(repo);
				if (!issues) continue;
				for (const issue of issues) {
					if (budget <= 0) break;
					if (claimed.has(issue.id) || this.dispatched.has(issue.id)) continue;
					this.dispatched.add(issue.id);
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
