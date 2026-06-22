/**
 * Orchestrator — control-loop skeleton for the self-healing fleet (#15).
 *
 * A periodic loop that will drive spawn → verify → land through injected deps,
 * so the policy is testable headless. Inert by default: `tick()` no-ops and
 * `start()` arms no timer unless OMP_SQUAD_AUTODRIVE is set. SquadManager wires
 * it today purely as the seam #15 fills in.
 */

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
	/** Log sink (defaults to no-op). */
	log?: (msg: string) => void;
}

/** Opt-in switch (default off): the fleet self-drives only when OMP_SQUAD_AUTODRIVE is set. */
function autodrive(): boolean {
	return !!process.env.OMP_SQUAD_AUTODRIVE;
}

export class Orchestrator {
	private readonly deps: OrchestratorDeps;
	private timer?: Timer;

	constructor(deps: OrchestratorDeps) {
		this.deps = deps;
	}

	/**
	 * Arm the control loop. No-op (arms no timer) unless OMP_SQUAD_AUTODRIVE is set, so
	 * the fleet self-drives strictly opt-in and the daemon leaks no timer when off.
	 */
	start(intervalMs = 30_000): void {
		if (this.timer || !autodrive()) return;
		this.timer = setInterval(() => void this.tick(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One control-loop step. Inert until OMP_SQUAD_AUTODRIVE is set; the self-healing policy
	 * (#15) lands here, reading `deps.listAgents()` then driving spawn/verify/land.
	 */
	async tick(): Promise<void> {
		if (!autodrive()) return;
		// ponytail: loop body lands with #15. Deps are wired and ready; today we only mark the
		//   tick so an opt-in run is observable, keeping the substrate shipped-but-inert.
		this.deps.log?.("orchestrator tick (no-op until #15)");
	}
}
