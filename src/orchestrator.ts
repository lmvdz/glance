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
	landAgentWork?: (agentId: string) => Promise<boolean>;
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
	/** Log sink (defaults to no-op). */
	log?: (msg: string) => void;
	/**
	 * Branch-keyed, restart-safe ledger of terminal decisions (OMPSQ-139). When present, halted /
	 * landed / staged are mirrored to disk by branch and consulted on the next boot, so a daemon
	 * restart no longer re-summons a human-parked agent or re-verifies already-landed/staged work.
	 * Omitted ⇒ in-memory only (tests, or an agent with no branch).
	 */
	persist?: OrchestratorPersistence;
}

/** On by default; set OMP_SQUAD_AUTODRIVE=0 to disable the self-driving control loop. */
function autodrive(): boolean {
	return process.env.OMP_SQUAD_AUTODRIVE !== "0";
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

	/**
	 * Admission queue the manager parks cap-denied spawns into; drained here under the WIP cap (#13).
	 * Public so the manager (and tests) can `enqueue` into the same instance the loop drains.
	 */
	readonly scheduler = new Scheduler();

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
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
	 */
	async tick(): Promise<void> {
		if (!autodrive()) return;
		const log = this.deps.log ?? (() => {});
		const route = this.deps.route ?? routeFailure;

		// ── Steps 1–3: each idle agent with unlanded work is verified, then landed, self-healed,
		//    or escalated. featureId is the verify/land key + "has landable work" signal. ──
		for (const a of this.deps.listAgents()) {
			if (a.status !== "idle") continue;
			if (this.halted.has(a.id) || (a.branch !== undefined && this.deps.persist?.isHalted(a.branch))) continue; // escalated / parked (this session or a prior boot) — the auto-loop no longer acts on it
			// Resolve the work unit + its verify/land edges. A feature-linked agent lands via the feature
			// path; a plain (typed-prompt) agent lands its OWN branch, so it auto-lands too — no manual
			// Land. Plain agents are gated on agentHasWork so the acceptance suite never runs on an idle
			// with nothing to merge.
			const feat = a.featureId;
			const plain = feat === undefined;
			const workId = feat ?? `agent:${a.id}`;
			if (this.landed.has(workId) || this.staged.has(workId) || (a.branch !== undefined && (this.deps.persist?.isLanded(a.branch) || this.deps.persist?.isStaged(a.branch)))) continue; // already merged, or held for one-tap Land (this session or a prior boot)
			if (plain) {
				if (!this.deps.verifyAgent || !this.deps.landAgentWork || !this.deps.agentHasWork) continue;
				if (!(await this.deps.agentHasWork(a.id))) continue;
			}

			// Step 3 (guard): a tripwire fires ⇒ summon a human now, before touching verify/land.
			if (this.deps.isCatastrophic?.(a)) {
				this.catastrophe(log, `tripwire fired for ${a.id} (${workId})`, a);
				continue;
			}

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
					this.markStaged(workId, a);
					log(`ready to land ${workId} (${a.id}) — re-adopted`);
				} else {
					await this.tryLand(a, plain, feat, workId, " — re-adopted", log);
				}
				continue;
			}

			if (plain ? await this.deps.verifyAgent!(a.id) : await this.deps.verify(feat!)) {
				// Safety valve: confirm mode holds a GREEN verify for the operator's one-tap Land.
				if (this.deps.holdForConfirm) {
					this.deps.notifyReady?.(a.id);
					this.markStaged(workId, a);
					this.attempts.delete(a.id);
					log(`ready to land ${workId} (${a.id})`);
					continue;
				}
				// Step 1: green gate → land (the land path closes the tracking Plane issue).
				await this.tryLand(a, plain, feat, workId, "", log);
				continue;
			}

			// Step 2: red gate → self-healing route, attempts tracked per agent.
			const attempts = this.attempts.get(a.id) ?? 0;
			const decision = route("red", { attempts, agentId: a.id });
			if (decision === "retry") {
				this.attempts.set(a.id, attempts + 1); // re-verify next tick under a higher attempt count
				log(`retry ${a.id} (${workId}) attempt ${attempts + 1}`);
			} else if (decision === "hold") {
				log(`hold ${a.id} (${workId})`); // parked — no further auto-action this tick
			} else if (plain) {
				// An ad-hoc agent that can't pass its gate isn't a catastrophe — park it (stop re-running
				// the suite each tick) and leave it for a manual Land. No human summon.
				this.markHalted(a);
				log(`parked ${a.id} (${workId}) — verify failed after ${attempts} attempt(s); land manually`);
			} else {
				// Step 3 (budget): repair budget exhausted → catastrophe.
				this.catastrophe(log, `repair budget exhausted for ${a.id} (${workId}) after ${attempts} attempt(s)`, a);
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
	}

	/**
	 * Land one agent's work and apply the blocked-land cap. On success: mark landed, clear the
	 * per-agent attempt + block counters. On a blocked land (diverged / conflict / dirty main):
	 * retrying the identical merge won't help until main or the branch changes, so cap retries at
	 * LAND_RETRY_CAP then park — never an infinite merge→reset loop. ponytail: in-memory; a daemon
	 * restart resets the counter (the manager's persisted, branch-keyed ledger holds across restarts).
	 * `label` annotates the log line (e.g. " — re-adopted").
	 */
	private async tryLand(a: AgentDTO, plain: boolean, feat: string | undefined, workId: string, label: string, log: (m: string) => void): Promise<void> {
		if (plain ? await this.deps.landAgentWork!(a.id) : await this.deps.land(feat!)) {
			this.landed.add(workId);
			if (a.branch !== undefined) this.deps.persist?.markLanded(a.branch);
			this.attempts.delete(a.id);
			this.landBlocks.delete(a.id);
			log(`landed ${workId} (${a.id})${label}`);
			return;
		}
		const blocks = (this.landBlocks.get(a.id) ?? 0) + 1;
		this.landBlocks.set(a.id, blocks);
		if (blocks >= LAND_RETRY_CAP) {
			this.markHalted(a);
			log(`land blocked for ${workId} (${a.id}) ${blocks}× — parked; resolve/land manually`);
		} else {
			log(`land blocked for ${workId} (${a.id}) — will retry (${blocks}/${LAND_RETRY_CAP})`);
		}
	}

	/** Mark an agent halted (this session) and mirror the decision to disk by branch so a restart
	 *  doesn't re-drive it (OMPSQ-139). */
	private markHalted(a: AgentDTO): void {
		this.halted.add(a.id);
		if (a.branch !== undefined) this.deps.persist?.markHalted(a.branch);
	}

	/** Mark work staged for one-tap Land (this session) and mirror to disk by branch (OMPSQ-139). */
	private markStaged(workId: string, a: AgentDTO): void {
		this.staged.add(workId);
		if (a.branch !== undefined) this.deps.persist?.markStaged(a.branch);
	}

	/**
	 * The ONLY place a human is summoned (#14): emit a clear `CATASTROPHE:` line, surface the agent
	 * out-of-band (Queue + push) via `onCatastrophe`, and stop the auto-loop from acting on it.
	 * Tripwires: repair budget exhausted, or `isCatastrophic` (infra failure / safety violation /
	 * regression oscillation). Never a silent drop — and never an invisible one (OMPSQ-135). The halt
	 * is persisted by branch so a restart doesn't re-summon (OMPSQ-139).
	 */
	private catastrophe(log: (m: string) => void, detail: string, a: AgentDTO): void {
		this.markHalted(a);
		log(`CATASTROPHE: ${detail}`);
		this.deps.onCatastrophe?.(a.id, detail);
	}
}
