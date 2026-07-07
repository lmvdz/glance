/**
 * Squad watchdog — turns a cheap resource sample into human-readable warnings, so a memory leak,
 * runaway/orphan host count, or host overload is SURFACED (daemon log + /api/health) instead of
 * discovered via a frozen dashboard. Pure: the daemon supplies the sample; this only judges it.
 */

import { envInt, envNumber } from "./config.ts";

export interface HealthSample {
	/** Daemon resident memory (MB). */
	rssMb: number;
	/** 1-minute load average. */
	load1: number;
	ncpu: number;
	/** Free / total host memory (0–1). */
	freeRatio: number;
	/** Live (non-terminal) roster agents. */
	agents: number;
	/** Detached agent-host processes (live sockets). */
	hosts: number;
}

export interface HealthLimits {
	maxRssMb: number;
	maxLoadPerCpu: number;
	minFreeRatio: number;
	maxHosts: number;
}

/** Limits scaled to the host. Env-tunable; `maxHosts` keys off the agent ceiling so a host count well
 *  above it flags an orphan/runaway leak (each agent is ≈ host + omp). */
export function defaultHealthLimits(ncpu: number, agentCeiling: number): HealthLimits {
	return {
		maxRssMb: envInt("OMP_SQUAD_MAX_RSS_MB", 1024),
		maxLoadPerCpu: envNumber("OMP_SQUAD_MAX_LOAD_PER_CPU", 2),
		minFreeRatio: envNumber("OMP_SQUAD_MIN_FREE_RATIO", 0.1),
		maxHosts: Math.max(agentCeiling * 3, 8),
	};
}

/** Human-readable warnings for every breached limit; an empty array means healthy. */
export function assessHealth(s: HealthSample, limits: HealthLimits): string[] {
	const w: string[] = [];
	if (s.rssMb > limits.maxRssMb) w.push(`daemon RSS ${Math.round(s.rssMb)}MB exceeds ${limits.maxRssMb}MB — possible memory leak`);
	if (s.ncpu > 0 && s.load1 / s.ncpu > limits.maxLoadPerCpu) w.push(`load ${s.load1.toFixed(2)} on ${s.ncpu} CPUs exceeds ${limits.maxLoadPerCpu}×`);
	if (s.freeRatio < limits.minFreeRatio) w.push(`free memory ${Math.round(s.freeRatio * 100)}% below ${Math.round(limits.minFreeRatio * 100)}%`);
	if (s.hosts > limits.maxHosts) w.push(`${s.hosts} detached agent-hosts exceeds ${limits.maxHosts} — runaway/orphan leak`);
	return w;
}
