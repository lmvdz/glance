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

import type { AutomationRecorder } from "./automation-log.ts";
import type { DispatchLedger } from "./dispatch-ledger.ts";
import type { AutomationSkipReason, IssueRef } from "./types.ts";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/**
 * Run a transient external (Plane) call with ONE retry, then surface-and-swallow. A thrown Plane
 * error on the poll used to be unhandled (it would reject the whole tick); a `null` return was
 * dropped silently. This retries once and, if both throw, runs `onFail` and returns `fallback`,
 * keeping the poll non-fatal — one repo's Plane blip never wedges the dispatcher.
 */
async function withRetry<T>(fn: () => Promise<T>, fallback: T, onFail: (e: unknown) => void): Promise<T> {
	try {
		return await fn();
	} catch {
		try {
			return await fn();
		} catch (e) {
			onFail(e);
			return fallback;
		}
	}
}

export function dispatchOrder(a: IssueRef, b: IssueRef): number {
	const ap = PRIORITY_RANK[(a.priority ?? "none").toLowerCase()] ?? PRIORITY_RANK.none;
	const bp = PRIORITY_RANK[(b.priority ?? "none").toLowerCase()] ?? PRIORITY_RANK.none;
	return ap - bp || (a.identifier ?? a.name).localeCompare(b.identifier ?? b.name);
}


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
	/** True while the model subscription is rate-limited (5h/weekly cap). When set, a tick spawns nothing —
	 *  spawning here would only launch agents that immediately stall on the same cap. Self-clears on cooldown. */
	paused?: () => boolean;
	/** Observability sink — one report per tick (a no-op poll is a heartbeat proving the loop is alive). */
	record?: AutomationRecorder;
	/** Restart-safe issue ids already dispatched by prior daemon boots. Omitted ⇒ in-memory only. */
	ledger?: DispatchLedger;
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
	/** True while a rate-limit pause is in effect — so the pause/resume is logged once per episode, not per tick. */
	private pauseLogged = false;

	constructor(deps: DispatchDeps) {
		this.deps = deps;
		this.maxActive = deps.maxActive ?? 3;
	}

	/** One poll: spawn routed agents for new open issues, bounded by `maxActive`. Returns the number spawned. */
	async tick(): Promise<number> {
		const t0 = Date.now();
		if (this.running) {
			this.deps.record?.({ durationMs: 0, skipReason: "overlap", detail: "previous dispatch tick still running" });
			return 0; // never overlap polls
		}
		// Model subscription rate-limited (5h/weekly cap): spawning now only launches agents that immediately
		// stall on the same cap. Skip the whole poll until the cooldown lifts; issues stay open for a later tick.
		if (this.deps.paused?.()) {
			if (!this.pauseLogged) {
				this.pauseLogged = true;
				this.deps.log("paused — model subscription rate-limited (5h/weekly cap); not spawning until it clears");
			}
			this.deps.record?.({ durationMs: Date.now() - t0, level: "warn", detail: "paused — model subscription rate-limited" });
			return 0;
		}
		if (this.pauseLogged) {
			this.pauseLogged = false;
			this.deps.log("resumed — model subscription rate-limit cleared");
		}
		this.running = true;
		let spawned = 0;
		let considered = 0;
		// Track WHY a no-op tick did nothing, so the digest shows "at cap" vs "nothing to do".
		// Cap hits are the strongest signal (force=true overwrites); per-issue reasons are first-wins.
		let skipReason: AutomationSkipReason | undefined;
		let skipDetail = "";
		const noteSkip = (reason: AutomationSkipReason, detail: string, force = false) => {
			if (force || !skipReason) {
				skipReason = reason;
				skipDetail = detail;
			}
		};
		try {
			const claimed = this.deps.claimed();
			let budget = this.maxActive - this.deps.activeCount();
			if (budget <= 0) noteSkip("wip-cap", "dispatch concurrency cap reached");
			for (const repo of this.deps.repos()) {
				if (this.atGlobalCap()) {
					noteSkip("wip-cap", "global WIP cap reached", true);
					break; // global WIP ceiling reached — leave remaining issues for a later tick
				}
				if (budget <= 0) {
					noteSkip("wip-cap", "dispatch concurrency cap reached", true);
					break;
				}
				// Poll is a transient external (Plane) call: retry once, then warn instead of letting a throw
				// reject the whole tick or dropping a repo silently. `null` (Plane unreachable / unconfigured)
				// is a clean skip; only a THROW retries/warns.
				const issues = await withRetry(
					() => this.deps.listIssues(repo),
					null,
					(e) => this.deps.log(`listIssues failed for ${repo} after retry — skipping this repo this tick: ${e instanceof Error ? e.message : String(e)}`),
				);
				if (!issues) continue;
				// Issue ids still open in THIS project this tick. A blocker absent here is completed/cancelled
				// (or gone), so it no longer blocks. Cross-project blockers aren't visible — see ceiling note.
				const openIds = new Set(issues.map((i) => i.id));
				const ordered = [...issues].sort(dispatchOrder);
				for (const issue of ordered) {
					considered++;
					if (budget <= 0) {
						noteSkip("wip-cap", "dispatch concurrency cap reached", true);
						break;
					}
					if (this.atGlobalCap()) {
						noteSkip("wip-cap", "global WIP cap reached", true); // recheck per spawn: each spawned agent counts toward the global cap
						break;
					}
					if (claimed.has(issue.id) || this.dispatched.has(issue.id) || this.deps.ledger?.has(issue.id)) {
						noteSkip("already-handled", "all open issues already claimed or dispatched");
						continue;
					}
					// Human-review / do-NOT-auto-land: stays visible in the UI's issue list but never auto-dispatched.
					// Not added to `dispatched`, logged once like the blocked_by deferral.
					if (issue.noAutoDispatch) {
						if (!this.skipLogged.has(issue.id)) {
							this.skipLogged.add(issue.id);
							this.deps.log(`skip ${issue.identifier ?? issue.id} — human-review / do-not-auto-land`);
						}
						noteSkip("human-review", "open issues require human review / do-not-auto-land");
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
						noteSkip("blocked", `open issue blocked by ${blockers.length} dependency issue(s)`);
						continue;
					}
					this.dispatched.add(issue.id);
					this.deps.ledger?.add(issue.id);
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
		// A no-op tick names why it did nothing; a productive tick is a plain heartbeat.
		if (spawned === 0) {
			this.deps.record?.({ durationMs: Date.now() - t0, found: considered, spawned, skipReason: skipReason ?? "idle", detail: skipDetail || "no open issues to dispatch" });
		} else {
			this.deps.record?.({ durationMs: Date.now() - t0, found: considered, spawned });
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
