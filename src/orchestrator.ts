/**
 * Orchestrator — self-healing control loop for the fleet (#15 + #14 + #13).
 *
 * A periodic loop that drives spawn → verify → land through injected deps, so the
 * policy is testable headless with no live daemon. Strictly opt-in: `tick()` returns
 * immediately and `start()` arms no timer unless OMP_SQUAD_AUTODRIVE is set. Every
 * effect goes through `deps`, so the loop unit-tests with fakes.
 *
 * Per tick:
 *   1. AUTO-LAND (#15)   — idle agents with unlanded work are verified, then landed
 *                          (the land path closes the tracking Plane issue).
 *   2. SELF-HEAL (#11/#12) — a red gate routes through `routeFailure`: retry / hold /
 *                          escalate, with per-agent attempts tracked in-memory.
 *   3. CATASTROPHE (#14) — the ONLY place a human is summoned: a clear `CATASTROPHE:`
 *                          log, then auto-action on that item stops. Never silent.
 *   4. ADMISSION DRAIN (#13) — parked spawn requests are admitted while the WIP cap
 *                          allows (the manager enqueues on cap-deny; the loop drains).
 */

import type { OrchestratorPersistence } from "./orchestrator-state.ts";
import { envBool } from "./config.ts";
import { headCommit } from "./proof.ts";
import { routeFailure, type FailureContext, type FailureKind, type FailureRoute } from "./resolver.ts";
import { liveAgents, Scheduler } from "./scheduler.ts";
import type { AgentDTO, CreateAgentOptions } from "./types.ts";

/** External edges the loop drives the fleet through — all injected so the loop runs without a live daemon. */
export interface OrchestratorDeps {
	/** Current roster snapshot the loop reasons over. */
	listAgents: () => AgentDTO[];
	/** Spawn an agent for a unit of work. */
	spawn: (opts: CreateAgentOptions) => Promise<AgentDTO>;
	/** Run the acceptance gate for a feature; true ⇒ green. */
	verify: (featureId: string) => Promise<boolean>;
	/** Land a feature's branches; true ⇒ merged. */
	land: (featureId: string) => Promise<boolean>;
	/**
	 * Featureless auto-land edges (the typed-prompt path). A plain agent has no featureId, so its
	 * OWN branch is the work unit: `agentHasWork` gates the costly suite (skip idles with nothing to
	 * merge), `verifyAgent` runs the acceptance gate in its worktree, `landAgentWork` merges it.
	 * When absent, plain agents are left untouched (back-compat with feature-only callers/tests).
	 */
	verifyAgent?: (agentId: string) => Promise<boolean>;
	/**
	 * Land a plain agent's OWN branch. true ⇒ merged; false ⇒ blocked (retry, then park); "staged" ⇒
	 * the conflict was auto-resolved and held for a one-tap Land (OMPSQ-138/175) — stage it, never
	 * re-attempt the merge, never park. "retryable" ⇒ an environmental precondition blocked it (a dirty
	 * main checkout) — retry next tick, never bump the block counter or park/halt.
	 */
	landAgentWork?: (agentId: string) => Promise<boolean | "staged" | "retryable">;
	agentHasWork?: (agentId: string) => Promise<boolean>;
	/**
	 * Failure router. Defaults to the resolver's `routeFailure` seam (escalate-everything until
	 * the ensemble #11/#12 lands); injectable so that ensemble — or a test — supplies the real
	 * retry/hold/escalate policy and owns the repair budget.
	 */
	route?: (kind: FailureKind, ctx?: FailureContext) => FailureRoute;
	/**
	 * Optional catastrophe tripwire (#14): return true to summon a human immediately for this
	 * agent, bypassing verify/land. Intended set: infra failure, safety violation, regression
	 * oscillation — conditions no retry can fix.
	 */
	isCatastrophic?: (agent: AgentDTO) => boolean;
	/**
	 * Safety valve (OMP_SQUAD_LAND_CONFIRM): when true, a GREEN verify does NOT auto-merge.
	 * The loop marks the agent ready-to-land and notifies, leaving the merge to the operator's
	 * one-tap Land. When false (default), the loop auto-merges as before.
	 */
	holdForConfirm?: boolean;
	/** Confirm-mode callback: the agent passed verify and is staged for a one-tap Land. */
	notifyReady?: (agentId: string) => void;
	/**
	 * Catastrophe callback (#14 / OMPSQ-135): a human is being summoned for this agent. The manager
	 * wires this to surface the agent in the attention Queue and fire a background push — the
	 * `CATASTROPHE:` log alone is invisible once the operator looks away. `detail` is the reason.
	 */
	onCatastrophe?: (agentId: string, detail: string) => void;
	/**
	 * Feed a note back into a live unit's next turn (composed into its next prompt). Used by the
	 * off-by-default veto-reprompt path (OMP_SQUAD_VETO_REPROMPT): when an independent validator vetoes
	 * a land, hand the unit the reason + unmet criteria so it can address them instead of blind-retrying
	 * an unchanged diff until the park ceiling. When absent, the loop behaves exactly as before.
	 */
	continueAgent?: (agentId: string, note: string) => Promise<void>;
	/** Log sink (defaults to no-op). */
	log?: (msg: string) => void;
	/**
	 * Restart-safe ledger of critical verify/land transitions. Keys are built from repo + branch +
	 * HEAD when possible, so reusing a branch name at a new commit is fresh work, while restarts still
	 * skip decisions for the exact same tree. Omitted ⇒ in-memory only (tests, or an agent with no branch).
	 */
	persist?: OrchestratorPersistence;
	/**
	 * Admission queue shared with the manager (OMPSQ-134). The manager parks cap-denied spawns
	 * (OMP_SQUAD_QUEUE_ON_FULL) into THIS instance; the loop's admission-drain step (step 4)
	 * dequeues + spawns them once a slot frees. Omitted ⇒ the loop owns a private Scheduler
	 * (tests that drive `orch.scheduler` directly). Wiring both to one instance is the whole fix:
	 * parking into a different Scheduler than the loop drains stranded every queued spawn.
	 */
	scheduler?: Scheduler;
}

/** On by default; set OMP_SQUAD_AUTODRIVE=0 to disable the self-driving control loop. */
function autodrive(): boolean {
	return envBool("OMP_SQUAD_AUTODRIVE", true);
}

/** Cap identical blocked-land retries before parking — a blocked land won't unblock by re-merging the same refs. */
const LAND_RETRY_CAP = 3;

export class Orchestrator {
	private readonly deps: OrchestratorDeps;
	private timer?: Timer;

	/** Per-agent red-gate retries, fed to `route` as the repair budget's `attempts`. */
	private readonly attempts = new Map<string, number>();
	/**
	 * Work ids already merged — skip them so the loop never re-verifies/re-lands landed work each
	 * tick. Within-session keyed by workId (feature OR `agent:<id>`); mirrored across restarts via
	 * `deps.persist` keyed by branch (OMPSQ-139).
	 */
	private readonly landed = new Set<string>();
	/** Agent ids handed to a human (catastrophe / parked) — the auto-loop stops acting on them.
	 *  Mirrored across restarts via `deps.persist` keyed by branch so a restart doesn't re-drive them. */
	private readonly halted = new Set<string>();
	/** Confirm-mode: work ids verified GREEN but held for a one-tap Land — skipped so the loop never
	 *  re-verifies. Mirrored across restarts via `deps.persist` keyed by branch (OMPSQ-139). */
	private readonly staged = new Set<string>();
	/** Per-agent blocked-land retries; parked after LAND_RETRY_CAP so a failing land never loops forever. */
	private readonly landBlocks = new Map<string, number>();
	/** Per work identity verify/land single-flight. A slow proof blocks only duplicate work for that agent/tree. */
	private readonly verifyLandLocks = new Set<string>();

	/** Re-entrancy guard — mirrors the pattern in scout.ts / observer.ts. A verify or land edge can
	 *  take longer than the 30s interval; without this guard the next tick overlaps the previous one,
	 *  double-counting attempts and spawning races. When true, the incoming tick skips entirely. */
	private ticking = false;
	/**
	 * Admission queue the manager parks cap-denied spawns into; drained here under the WIP cap (#13).
	 * Public so the manager (and tests) can `enqueue` into the same instance the loop drains.
	 */
	readonly scheduler: Scheduler;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
		// Share the manager's Scheduler when wired (OMPSQ-134), else own a private one (tests).
		this.scheduler = deps.scheduler ?? new Scheduler();
	}

	/**
	 * Arm the control loop. No-op (arms no timer) unless OMP_SQUAD_AUTODRIVE is set, so
	 * the fleet self-drives strictly opt-in and the daemon leaks no timer when off.
	 */
	start(intervalMs = 30_000): void {
		if (this.timer || !autodrive()) return;
		// Contain a tick rejection: a throwing verify/land edge must be logged + retried next tick,
		// never an unhandled rejection (that crashes the whole daemon). The root cause is also fixed
		// at the source (runProof is total), but this guarantees no future throwing edge can take the fleet down.
		this.timer = setInterval(() => void this.tick().catch((e) => (this.deps.log ?? (() => {}))(`tick error (contained): ${e instanceof Error ? e.message : String(e)}`)), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One control-loop step. Inert until OMP_SQUAD_AUTODRIVE is set; then drives the per-tick
	 * policy (auto-land → self-heal → catastrophe → admission drain) entirely through `deps`.
	 *
	 * Re-entrancy guard: if a previous tick's verify/land is still in flight (took > interval),
	 * the new tick returns immediately. This mirrors the pattern in scout.ts / observer.ts and
	 * prevents double-counted attempt budgets and overlapping land calls.
	 */
	async tick(): Promise<void> {
		if (!autodrive()) return;
		if (this.ticking) return; // previous tick still in flight — skip rather than overlap
		this.ticking = true;
		try {
		const log = this.deps.log ?? (() => {});
		const route = this.deps.route ?? routeFailure;

		// ── Steps 1–3: each idle agent with unlanded work is verified, then landed, self-healed,
		//    or escalated. featureId is the verify/land key + "has landable work" signal. ──
		for (const a of this.deps.listAgents()) {
			if (a.status !== "idle") continue;
			// Resolve the work unit + its verify/land edges. A feature-linked agent lands via the feature
			// path; a plain (typed-prompt) agent lands its OWN branch, so it auto-lands too — no manual
			// Land. Plain agents are gated on agentHasWork so the acceptance suite never runs on an idle
			// with nothing to merge.
			const feat = a.featureId;
			const plain = feat === undefined;
			const workId = feat ?? `agent:${a.id}`;
			const stateKey = await this.stateKey(a);
			const lockKey = stateKey ?? workId;
			if (this.halted.has(a.id) || (stateKey !== undefined && this.deps.persist?.isHalted(stateKey))) continue; // escalated / parked — the auto-loop no longer acts on it
			if (this.landed.has(workId) || this.staged.has(workId) || (stateKey !== undefined && (this.deps.persist?.isLanded(stateKey) || this.deps.persist?.isStaged(stateKey)))) continue; // already merged, or held for one-tap Land
			if (this.verifyLandLocks.has(lockKey)) continue;
			if (plain) {
				if (!this.deps.verifyAgent || !this.deps.landAgentWork || !this.deps.agentHasWork) continue;
				if (!(await this.deps.agentHasWork(a.id))) continue;
			}

			// Step 3 (guard): a tripwire fires ⇒ summon a human now, before touching verify/land.
			if (this.deps.isCatastrophic?.(a)) {
				this.catastrophe(log, `tripwire fired for ${a.id} (${workId})`, a, stateKey);
				continue;
			}

			this.verifyLandLocks.add(lockKey);
			try {
				// Re-adopted idle agent (OMPSQ-164): its work was COMPLETE before a relaunch — committed
				// (ahead>0, gated above by agentHasWork for plain agents), clean worktree — but it never
				// re-ran, so the event-driven auto-land (autoLandOnSuccess on workflow_done) never fired.
				// An isolated worktree pre-verify gives a FALSE NEGATIVE here (a stale-but-mergeable branch
				// lacks newer main code), so skip it: land DIRECTLY and let the land path's own merge → gate
				// → rollback-on-red be the gate. Confirm mode stages it for a one-tap Land instead. The
				// blocked-land cap in tryLand still applies, so a genuinely-failing MERGED gate parks.
				if (a.adopted) {
					if (this.deps.holdForConfirm) {
						this.deps.notifyReady?.(a.id);
						if (!this.persistCritical("staged", stateKey, a, log)) continue;
						this.markStaged(workId, a, stateKey);
						log(`ready to land ${workId} (${a.id}) — re-adopted`);
					} else {
						await this.tryLand(a, plain, feat, workId, stateKey, " — re-adopted", log);
					}
					continue;
				}

				if (!this.persistCritical("verifying", stateKey, a, log)) continue;
				if (plain ? await this.deps.verifyAgent!(a.id) : await this.deps.verify(feat!)) {
					if (!this.persistCritical("verified", stateKey, a, log)) continue;
					// Safety valve: confirm mode holds a GREEN verify for the operator's one-tap Land.
					if (this.deps.holdForConfirm) {
						this.deps.notifyReady?.(a.id);
						if (!this.persistCritical("staged", stateKey, a, log)) continue;
						this.markStaged(workId, a, stateKey);
						this.attempts.delete(a.id);
						log(`ready to land ${workId} (${a.id})`);
						continue;
					}
					// Step 1: green gate → land (the land path closes the tracking Plane issue).
					await this.tryLand(a, plain, feat, workId, stateKey, "", log);
					continue;
				}

				// Step 2: red gate → self-healing route, attempts tracked per agent.
				const attempts = this.attempts.get(a.id) ?? 0;
				const decision = route("red", { attempts, agentId: a.id });
				if (decision === "retry") {
					this.attempts.set(a.id, attempts + 1); // re-verify next tick under a higher attempt count
					log(`retry ${a.id} (${workId}) attempt ${attempts + 1}`);
				} else if (decision === "hold") {
					this.persistCritical("blocked", stateKey, a, log);
					log(`hold ${a.id} (${workId})`); // parked — no further auto-action this tick
				} else if (plain) {
					// An ad-hoc agent that can't pass its gate isn't a catastrophe — park it (stop re-running
					// the suite each tick) and leave it for a manual Land. No human summon.
					this.persistCritical("blocked", stateKey, a, log);
					this.markHalted(a, stateKey);
					log(`parked ${a.id} (${workId}) — verify failed after ${attempts} attempt(s); land manually`);
				} else {
					// Step 3 (budget): repair budget exhausted → catastrophe.
					this.catastrophe(log, `repair budget exhausted for ${a.id} (${workId}) after ${attempts} attempt(s)`, a, stateKey);
				}
			} finally {
				this.verifyLandLocks.delete(lockKey);
			}
		}

		// ── Step 4: admission drain (#13). Spawn parked requests while the WIP cap has headroom;
		//    re-count live agents each pass so freshly spawned ones tighten the ceiling. ──
		while (this.scheduler.queued > 0 && this.scheduler.canAdmit(liveAgents(this.deps.listAgents()))) {
			const req = this.scheduler.dequeue();
			if (!req) break;
			await this.deps.spawn(req);
			log(`admitted queued spawn ${req.name ?? req.repo}`);
		}

		// ── Step 5: ledger purge (#19). Drop entries for branches/HEADs that no longer appear in
		//    the roster so the on-disk ledger doesn't grow unbounded as branches are cleaned up. ──
		if (this.deps.persist) {
			const rosterKeys = (await Promise.all(this.deps.listAgents().map((a) => this.stateKey(a)))).filter((k): k is string => k !== undefined);
			this.deps.persist.purgeStale(rosterKeys);
		}
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Land one agent's work and apply the blocked-land cap. On success: mark landed, clear the
	 * per-agent attempt + block counters. On a blocked land (diverged / conflict / dirty main):
	 * retrying the identical merge won't help until main or the branch changes, so cap retries at
	 * LAND_RETRY_CAP then park — never an infinite merge→reset loop. ponytail: in-memory; a daemon
	 * restart resets the counter (the manager's persisted, branch-keyed ledger holds across restarts).
	 * `label` annotates the log line (e.g. " — re-adopted").
	 */
	private async tryLand(a: AgentDTO, plain: boolean, feat: string | undefined, workId: string, stateKey: string | undefined, label: string, log: (m: string) => void): Promise<void> {
		const outcome = plain ? await this.deps.landAgentWork!(a.id) : await this.deps.land(feat!);
		// Staged (OMPSQ-138/175): the conflict was auto-resolved and held for a one-tap Land. It is
		// neither merged nor blocked — stage it (like a confirm-mode hold) so the loop stops acting on
		// it: no merge-retry, no park. The operator's one-tap Land keeps the resolved merge.
		if (outcome === "staged") {
			this.deps.notifyReady?.(a.id);
			if (!this.persistCritical("staged", stateKey, a, log)) return;
			this.markStaged(workId, a, stateKey);
			this.attempts.delete(a.id);
			this.landBlocks.delete(a.id);
			log(`ready to land ${workId} (${a.id})${label} — conflict auto-resolved, awaiting confirm`);
			return;
		}
		// Retryable (dirty main checkout): an environmental precondition, not a branch defect — do NOT
		// bump the blocked-land counter or park/halt. Skip this tick; a later tick lands it once main is
		// clean. A transient dirty main would otherwise halt every healthy branch behind it. Must precede
		// the truthy `if (outcome)` below, since "retryable" is a truthy string.
		if (outcome === "retryable") {
			log(`land deferred ${workId} (${a.id})${label} — main checkout busy; will retry`);
			return;
		}
		if (outcome) {
			if (!this.persistCritical("landed", stateKey, a, log)) return;
			this.landed.add(workId);
			this.attempts.delete(a.id);
			this.landBlocks.delete(a.id);
			log(`landed ${workId} (${a.id})${label}`);
			return;
		}
		const blocks = (this.landBlocks.get(a.id) ?? 0) + 1;
		this.landBlocks.set(a.id, blocks);
		// Off-by-default (OMP_SQUAD_VETO_REPROMPT), once per veto cycle (blocks === 1): feed the independent
		// validator's veto reason back into the SAME unit's next turn so it can address the unmet criteria,
		// instead of blind-retrying an unchanged diff until the park ceiling. Fire-and-forget — NEVER awaited
		// in the tick (a full agent turn here would stall verify/land for every other agent behind it); the
		// manager's closure owns the .catch, the armed-convergence double-inject guard, and the recovery
		// metric. The LAND_RETRY_CAP park ceiling below is unchanged — this adds one real chance to react.
		if (blocks === 1 && envBool("OMP_SQUAD_VETO_REPROMPT", false) && a.validation?.verdict === "veto" && this.deps.continueAgent) {
			const unmet = (a.validation.perCriterion ?? []).filter((c) => !c.satisfied).map((c) => c.id).join(", ");
			const note = `Independent validator vetoed this land: ${a.validation.rationale || "(no rationale given)"}. Unmet criteria: ${unmet || "(unspecified)"}. Address these, then the next verify/land will re-check.`;
			void this.deps.continueAgent(a.id, note);
		}
		if (blocks >= LAND_RETRY_CAP) {
			this.persistCritical("blocked", stateKey, a, log);
			this.markHalted(a, stateKey);
			log(`land blocked for ${workId} (${a.id}) ${blocks}× — parked; resolve/land manually`);
		} else {
			log(`land blocked for ${workId} (${a.id}) — will retry (${blocks}/${LAND_RETRY_CAP})`);
		}
	}

	/** Durable key for a branch at a specific tree. Falls back to repo+branch when HEAD is unavailable. */
	private async stateKey(a: AgentDTO): Promise<string | undefined> {
		if (a.branch === undefined) return undefined;
		const head = await headCommit(a.worktree);
		return JSON.stringify([a.repoId ?? a.repo, a.branch, head || "unknown"]);
	}

	/** Persist a critical transition before continuing. On failure, halt this agent in memory and skip work. */
	private persistCritical(kind: "verifying" | "verified" | "blocked" | "halted" | "landed" | "staged", key: string | undefined, a: AgentDTO, log: (m: string) => void): boolean {
		if (key === undefined || this.deps.persist === undefined) return true;
		try {
			if (kind === "verifying") this.deps.persist.markVerifying(key);
			else if (kind === "verified") this.deps.persist.markVerified(key);
			else if (kind === "blocked") this.deps.persist.markBlocked(key);
			else if (kind === "halted") this.deps.persist.markHalted(key);
			else if (kind === "landed") this.deps.persist.markLanded(key);
			else this.deps.persist.markStaged(key);
			return true;
		} catch (e) {
			this.halted.add(a.id);
			log(`orchestrator persistence failed for ${kind} ${a.id}; halted fail-closed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	/** Mark an agent halted (this session) and mirror the decision to disk by branch/tree. */
	private markHalted(a: AgentDTO, stateKey?: string): void {
		this.halted.add(a.id);
		this.persistCritical("halted", stateKey, a, this.deps.log ?? (() => {}));
	}

	/** Mark work staged for one-tap Land (this session) and mirror to disk by branch/tree. */
	private markStaged(workId: string, a: AgentDTO, stateKey?: string): void {
		this.staged.add(workId);
		this.persistCritical("staged", stateKey, a, this.deps.log ?? (() => {}));
	}

	/**
	 * The ONLY place a human is summoned (#14): emit a clear `CATASTROPHE:` line, surface the agent
	 * out-of-band (Queue + push) via `onCatastrophe`, and stop the auto-loop from acting on it.
	 */
	private catastrophe(log: (m: string) => void, detail: string, a: AgentDTO, stateKey?: string): void {
		this.markHalted(a, stateKey);
		log(`CATASTROPHE: ${detail}`);
		this.deps.onCatastrophe?.(a.id, detail);
	}
}
