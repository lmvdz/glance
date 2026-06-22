/**
 * Host resource pressure — the pure admission gate (underPressure). No machine reads:
 * readings are supplied directly and thresholds are passed as an explicit env so the
 * branches (load ceiling, free-memory floor, env overrides) are deterministic.
 */

import { expect, test } from "bun:test";
import { type HostReading, underPressure } from "../src/resource.ts";

const healthy: HostReading = { load1: 1, ncpu: 6, freeRatio: 0.5 };

test("no pressure when load and free memory are healthy", () => {
	expect(underPressure(healthy, {})).toBe(false);
});

test("pressure when load per cpu exceeds the default ceiling (1.5)", () => {
	expect(underPressure({ ...healthy, load1: 12 }, {})).toBe(true); // 12/6 = 2.0 > 1.5
	expect(underPressure({ ...healthy, load1: 8 }, {})).toBe(false); // 8/6 ≈ 1.33 < 1.5
});

test("pressure when the free-memory fraction drops below the default floor (0.1)", () => {
	expect(underPressure({ ...healthy, freeRatio: 0.05 }, {})).toBe(true);
	expect(underPressure({ ...healthy, freeRatio: 0.2 }, {})).toBe(false);
});

test("thresholds are env-tunable", () => {
	// tighter load ceiling makes a previously-fine reading pressured
	expect(underPressure({ ...healthy, load1: 7 }, { OMP_SQUAD_MAX_LOAD_PER_CPU: "1" })).toBe(true); // 7/6 > 1
	// looser free floor clears a previously-pressured reading
	expect(underPressure({ ...healthy, freeRatio: 0.05 }, { OMP_SQUAD_MIN_FREE_RATIO: "0.01" })).toBe(false);
});
