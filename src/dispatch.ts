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

import * as path from "node:path";
import { existsSync } from "node:fs";
import type { AutomationRecorder } from "./automation-log.ts";
import type { DispatchLedger } from "./dispatch-ledger.ts";
import type { AgentDTO, AutomationSkipReason, IssueRef } from "./types.ts";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function norm(p: string): string {
	const out: string[] = [];
	for (const seg of p.trim().split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return out.join("/").toLowerCase();
}

function under(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`);
}

function overlaps(a: string, b: string): boolean {
	const x = norm(a);
	const y = norm(b);
	return x !== "" && y !== "" && (under(x, y) || under(y, x));
}

function pathExistsInRepo(repo: string, rel: string): boolean {
	const safe = norm(rel);
	if (!safe) return false;
	const full = path.resolve(repo, safe);
	const root = path.resolve(repo);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) return false;
	return existsSync(full);
}

function issueKey(issue: IssueRef): string {
	return issue.identifier ?? issue.id;
}

function issueProduces(issue: IssueRef): string[] {
	return issue.produces?.length ? issue.produces : (issue.owns ?? []);
}

function hasScopeCycle(issue: IssueRef, ordered: readonly IssueRef[]): boolean {
	const requires = issue.requires ?? [];
	if (!requires.length) return false;
	const produced = issueProduces(issue);
	if (!produced.length) return false;
	return ordered.some((other) => other.id !== issue.id && (other.requires ?? []).some((req) => produced.some((prod) => overlaps(req, prod))) && issueProduces(other).some((prod) => requires.some((req) => overlaps(req, prod))));
}

function liveProducedPaths(repo: string, live: readonly AgentDTO[]): string[] {
	return live.filter((a) => a.repo === repo && a.status !== "stopped" && a.status !== "error").flatMap((a) => a.produces?.length ? a.produces : (a.owns ?? []));
}

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
	/**
	 * True while `provider` (a `ModelLineage`-grain string — see model-lineage.ts) is rate-limited (5h/
	 * weekly cap) — spawning onto it would only launch agents that immediately stall on the same cap.
	 * Called with NO argument at the top of a tick when `providerFor` is absent (or the ladder is inert
	 * — see `secondLaneAvailable`): the legacy global check, true while ANY provider is capped, so a
	 * tick spawns nothing (byte-for-byte the old single-global-cooldown behavior). Called WITH a
	 * provider once per candidate issue when `providerFor` is wired: only that issue is skipped, so a
	 * capped provider no longer freezes units bound for a different, live provider. Self-clears on cooldown.
	 */
	paused?: (provider?: string) => boolean;
	/**
	 * Degradation ladder (concern 06): resolve the provider a prospective spawn for `issue` in `repo`
	 * would land on, so `tick()` can gate per-unit instead of once globally. Undefined ⇒ no per-unit
	 * differentiation is possible — the dispatcher falls back to the legacy top-of-tick `paused()`
	 * no-arg check (zero behavior change from before this concern).
	 */
	providerFor?: (repo: string, issue: IssueRef) => string | undefined;
	/**
	 * True when a second verified, differently-provider'd harness is actually enabled (see
	 * `harness-registry.ts`'s `hasSecondVerifiedProviderLane`) — i.e. per-unit gating has real
	 * differentiation to act on, not just a relabeled global pause. Only an explicit `false` disables
	 * per-unit gating (falls back to the legacy top-of-tick check + logs once that the ladder is inert).
	 * Undefined (or true) ⇒ per-unit gating runs whenever `providerFor` is supplied.
	 */
	secondLaneAvailable?: () => boolean;
	/** Observability sink — one report per tick (a no-op poll is a heartbeat proving the loop is alive). */
	record?: AutomationRecorder;
	/** Restart-safe issue ids already dispatched by prior daemon boots. Omitted ⇒ in-memory only. */
	ledger?: DispatchLedger;
	/**
	 * Stale-issue guard: true when the issue's work is already recorded done in the repo (its plan
	 * concern doc is closed on the checked-out tree). A Plane issue that outlives its landed concern
	 * would otherwise be re-dispatched, and the fresh unit's branch reverts evolved code back to the
	 * spec's day-one state (the visual-plan-blocks incident). Detected ⇒ ledgered, never spawned.
	 * The implementation may also close the issue to heal the drift. Errors ⇒ treated as not-done.
	 */
	alreadyDone?: (repo: string, issue: IssueRef) => Promise<boolean>;
	/** Current live/queued agents; used to defer read-after-write hazards until producers land. */
	liveAgents?: () => AgentDTO[];
	/** Advisory scope finding sink. */
	scopeFinding?: (repo: string, message: string) => void;
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
	/** True while a rate-limit pause is in effect — so the pause/resume is logged once per episode, not per tick.
	 *  Only used on the legacy global-check path (no `providerFor`, or the ladder is inert). */
	private pauseLogged = false;
	/** True once the "ladder is inert" log has fired — logged once, not every tick. */
	private inertLogged = false;
	/** Providers currently logged as paused under per-unit gating — logged once per pause/resume
	 *  transition, mirroring `pauseLogged` but per bucket instead of one global flag. */
	private readonly pausedProvidersLogged = new Set<string>();

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
		// Degradation ladder (concern 06): per-unit gating only has real differentiation to offer once
		// (a) the caller can resolve a prospective unit's provider (`providerFor`) AND (b) a second
		// verified, differently-provider'd harness is actually enabled (`secondLaneAvailable`). Absent
		// either, fall back to the pre-ladder top-of-tick global check byte-for-byte — no regression.
		const perUnitGating = !!this.deps.providerFor && this.deps.secondLaneAvailable?.() !== false;
		if (!perUnitGating && this.deps.providerFor && !this.inertLogged) {
			this.inertLogged = true;
			this.deps.log("per-provider dispatch gating inert — no second verified provider lane configured; behaves like the single global pause");
		}
		if (perUnitGating) this.inertLogged = false;

		if (!perUnitGating) {
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
		} else {
			// Per-unit gating: no top-of-tick short-circuit — each candidate issue below is checked
			// against ITS OWN provider, so a capped provider skips only its units, not the whole tick.
			// Reconcile pause→resume logging here (once per provider, not per skipped issue).
			for (const p of [...this.pausedProvidersLogged]) {
				if (!this.deps.paused?.(p)) {
					this.pausedProvidersLogged.delete(p);
					this.deps.log(`resumed — provider ${p} rate-limit cleared`);
				}
			}
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
					// Degradation ladder (concern 06): gate PER ISSUE on the provider it would actually spawn
					// onto — a cap on provider A skips only A's units; B's units keep dispatching this same
					// tick. `continue`, never `break` — a later issue in this repo (or a later repo) may
					// resolve to a different, live provider.
					if (perUnitGating) {
						const provider = this.deps.providerFor?.(repo, issue);
						if (this.deps.paused?.(provider)) {
							const label = provider ?? "unknown";
							if (!this.pausedProvidersLogged.has(label)) {
								this.pausedProvidersLogged.add(label);
								this.deps.log(`paused — provider ${label} rate-limited (usage cap); skipping its units, other providers keep dispatching`);
							}
							noteSkip("blocked", `provider ${label} rate-limited (usage cap)`);
							continue;
						}
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
					// Stale-issue guard: the repo already records this work done (closed plan concern) —
					// spawning would re-implement a shipped spec against an evolved main. Ledgered so the
					// (possibly failing-to-close) issue isn't re-examined every tick. Guard errors ⇒ dispatch
					// normally (fail open): a broken guard must never wedge the autonomous loop.
					if (this.deps.alreadyDone && (await this.deps.alreadyDone(repo, issue).catch(() => false))) {
						this.dispatched.add(issue.id);
						this.deps.ledger?.add(issue.id);
						this.deps.log(`skip ${issue.identifier ?? issue.id} — its plan concern is already closed in ${repo} (stale issue, not dispatching)`);
						noteSkip("already-done", "open issue's plan concern is already closed in the repo");
						continue;
					}
					// Scope dependency gate: operator-declared requires are real ordering constraints.
					// Inferred requirements are advisory only; never let a hallucinated path wedge dispatch.
					const requires = issue.requires ?? [];
					const unmet = requires.filter((r) => !pathExistsInRepo(repo, r) && !liveProducedPaths(repo, this.deps.liveAgents?.() ?? []).some((p) => overlaps(r, p)));
					if (unmet.length > 0) {
						if (issue.scopeSource === "operator" && !hasScopeCycle(issue, ordered)) {
							if (!this.blockedLogged.has(issue.id)) {
								this.blockedLogged.add(issue.id);
								this.deps.log(`defer ${issueKey(issue)} — requires unmet: ${unmet.join(", ")}`);
							}
							noteSkip("blocked", `requires unmet: ${unmet.join(", ")}`);
							continue;
						}
						const why = hasScopeCycle(issue, ordered) ? "requires cycle" : "inferred requires unmet";
						this.deps.scopeFinding?.(repo, `${why} for ${issueKey(issue)}: ${unmet.join(", ")}`);
						this.deps.log(`scope warning ${issueKey(issue)} — ${why}: ${unmet.join(", ")}`);
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
