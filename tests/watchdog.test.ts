/**
 * Watchdog — pure health assessment. Samples + limits are passed directly (no os/process reads), so
 * each breach (daemon RSS leak, host overload, low memory, runaway host count) is deterministic.
 */

import { expect, test } from "bun:test";
import { assessHealth, defaultHealthLimits, type HealthLimits, type HealthSample } from "../src/watchdog.ts";

const limits: HealthLimits = { maxRssMb: 1024, maxLoadPerCpu: 2, minFreeRatio: 0.1, maxHosts: 8 };
const ok: HealthSample = { rssMb: 200, load1: 2, ncpu: 6, freeRatio: 0.5, agents: 2, hosts: 4 };

test("healthy sample → no warnings", () => {
	expect(assessHealth(ok, limits)).toEqual([]);
});

test("flags a daemon RSS leak", () => {
	expect(assessHealth({ ...ok, rssMb: 2000 }, limits).some((w) => w.includes("RSS"))).toBe(true);
});

test("flags host overload (load per cpu over limit)", () => {
	expect(assessHealth({ ...ok, load1: 18 }, limits).some((w) => w.includes("load"))).toBe(true); // 18/6 = 3 > 2
	expect(assessHealth({ ...ok, load1: 11 }, limits)).toEqual([]); // 11/6 ≈ 1.8 < 2 → fine
});

test("flags low free memory", () => {
	expect(assessHealth({ ...ok, freeRatio: 0.05 }, limits).some((w) => w.includes("free memory"))).toBe(true);
});

test("flags a runaway / orphan host count", () => {
	expect(assessHealth({ ...ok, hosts: 20 }, limits).some((w) => w.includes("detached"))).toBe(true);
});

test("reports every breach at once", () => {
	expect(assessHealth({ rssMb: 5000, load1: 30, ncpu: 6, freeRatio: 0.01, agents: 99, hosts: 99 }, limits).length).toBe(4);
});

test("defaultHealthLimits scales maxHosts off the agent ceiling (floor 8)", () => {
	expect(defaultHealthLimits(6, 4).maxHosts).toBe(12); // 4×3
	expect(defaultHealthLimits(6, 1).maxHosts).toBe(8); // floor
});
