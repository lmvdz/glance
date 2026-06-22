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

/** Terminal statuses — an agent here has finished and frees its WIP slot. */
const TERMINAL_STATUSES: Record<string, true> = { stopped: true, error: true };

/** Agents occupying a live WIP slot — everything not in a terminal state. The concurrency cap counts these. */
export function liveAgents(dtos: AgentDTO[]): number {
	return dtos.filter((d) => !TERMINAL_STATUSES[d.status]).length;
}

export class Scheduler {
	/** FIFO of spawn requests parked when admission was denied. Drained by the backpressure loop (#13). */
	private readonly queue: CreateAgentOptions[] = [];

	/**
	 * Global live-agent WIP ceiling: OMP_SQUAD_MAX_WIP (default 6). Read per call so an
	 * env change (tests, ops) takes effect without a restart — matching the prior inline read.
	 */
	cap(): number {
		return Number(process.env.OMP_SQUAD_MAX_WIP) || 6;
	}

	/** True when one more live agent fits under the ceiling. */
	canAdmit(liveCount: number): boolean {
		return liveCount < this.cap();
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
