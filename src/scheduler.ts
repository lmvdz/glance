/**
 * Scheduler — admission + concurrency for the squad.
 *
 * Owns the global WIP ceiling (live-agent count vs OMP_SQUAD_MAX_WIP) and a
 * simple in-memory FIFO of spawn requests parked when admission is denied. The
 * cap decision is `canAdmit(liveCount)` — squad-manager calls it instead of
 * inlining the count. The queue is the seam the backpressure work (#13) plugs
 * into: squad-manager wires the Scheduler but does not yet park on rejection,
 * so behavior is unchanged until #13 lands.
 */

import type { AgentDTO, CreateAgentOptions } from "./types.ts";
import { readHost, underPressure } from "./resource.ts";
import * as os from "node:os";

/** Terminal statuses — an agent here has finished and frees its WIP slot. */
const TERMINAL_STATUSES: Record<string, true> = { stopped: true, error: true };

/** Agents occupying a live WIP slot — everything not in a terminal state. The concurrency cap counts these. */
export function liveAgents(dtos: AgentDTO[]): number {
	return dtos.filter((d) => !TERMINAL_STATUSES[d.status]).length;
}

/** Safe default WIP cap when OMP_SQUAD_MAX_WIP is unset: ~half the host's CPUs (min 2), so a launch is
 *  bounded even without up.sh's env. */
export function defaultWipCap(): number {
	return Math.max(2, Math.floor((os.cpus().length || 2) / 2));
}

/**
 * Default host-pressure probe. Gating is opt-in (OMP_SQUAD_RESOURCE_GATE; up.sh sets it). The safe count
 * caps (defaultWipCap / hardAgentCeiling) already bound a bare launch on their own — this adds load-aware
 * backoff on top. Read per call; an injected probe (tests) bypasses the flag.
 */
function hostPressureProbe(): boolean {
	return process.env.OMP_SQUAD_RESOURCE_GATE ? underPressure(readHost()) : false;
}

export class Scheduler {
	/** FIFO of spawn requests parked when admission was denied. Drained by the backpressure loop (#13). */
	private readonly queue: CreateAgentOptions[] = [];
	/** Host-pressure probe — injectable so admission logic is tested without reading the machine. */
	private readonly probe: () => boolean;

	constructor(probe: () => boolean = hostPressureProbe) {
		this.probe = probe;
	}

	/**
	 * Global live-agent WIP ceiling: OMP_SQUAD_MAX_WIP (default ~half the host CPUs). Read per call so an
	 * env change (tests, ops) takes effect without a restart — matching the prior inline read.
	 */
	cap(): number {
		return Number(process.env.OMP_SQUAD_MAX_WIP) || defaultWipCap();
	}

	/** True when the host is too loaded to admit another agent, independent of the count cap. */
	pressured(): boolean {
		return this.probe();
	}

	/** True when one more live agent fits under the count ceiling AND the host isn't under pressure. */
	canAdmit(liveCount: number): boolean {
		return liveCount < this.cap() && !this.probe();
	}

	/** Park a denied spawn request (FIFO). */
	enqueue(req: CreateAgentOptions): void {
		this.queue.push(req);
	}

	/** Pop the oldest parked request, or undefined when none waits. */
	dequeue(): CreateAgentOptions | undefined {
		return this.queue.shift();
	}

	/** Count of parked requests awaiting admission. */
	get queued(): number {
		return this.queue.length;
	}
}
