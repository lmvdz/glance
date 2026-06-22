/**
 * Host resource pressure.
 *
 * The WIP cap bounds *agents*, but each agent is several processes, so a backlog
 * spawn-storm can saturate CPU/RAM and hang the host before the count cap bites
 * (observed: load 160). This gauges the actual host — on WSL that's the distro the
 * agents run in, which is what hangs — so admission can back off under real pressure.
 *
 * `readHost` is the only impure edge (os.*); `underPressure` is pure so the admission
 * decision is tested without touching the machine.
 */

import os from "node:os";

export interface HostReading {
	/** 1-minute load average. */
	load1: number;
	/** Logical CPUs the load is spread over (never 0). */
	ncpu: number;
	/** Free-memory fraction of total (0–1). */
	freeRatio: number;
}

/** Snapshot the host the agents run in (on WSL: the distro VM — the thing that hangs). */
export function readHost(): HostReading {
	return {
		load1: os.loadavg()[0] ?? 0,
		ncpu: os.cpus().length || 1,
		freeRatio: os.totalmem() > 0 ? os.freemem() / os.totalmem() : 1,
	};
}

/**
 * True when the host is too loaded to admit another agent. Thresholds are env-tunable and
 * read per call (ops/tests retune without a restart):
 *   OMP_SQUAD_MAX_LOAD_PER_CPU — block when load1/ncpu exceeds it (default 1.5)
 *   OMP_SQUAD_MIN_FREE_RATIO   — block when the free-memory fraction drops below it (default 0.1)
 */
export function underPressure(r: HostReading, env: Record<string, string | undefined> = process.env): boolean {
	const maxLoadPerCpu = Number(env.OMP_SQUAD_MAX_LOAD_PER_CPU) || 1.5;
	const minFreeRatio = Number(env.OMP_SQUAD_MIN_FREE_RATIO) || 0.1;
	return r.load1 / r.ncpu > maxLoadPerCpu || r.freeRatio < minFreeRatio;
}
