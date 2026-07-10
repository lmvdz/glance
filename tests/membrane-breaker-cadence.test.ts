/**
 * Membrane breaker cadence wiring (eap-borrows concern 05, batch-2 review fix) — the caller
 * `runtime-settings.ts#runMembraneBreaker` was built for but never got. This is the load-bearing test:
 * it exercises the REAL join (receipts.jsonl + task-outcomes.jsonl on disk → CellMetrics → the pure
 * breaker check → the persisted settings flag), not just the already-covered pure functions.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { membraneBreakerCadence } from "../src/membrane-breaker-cadence.ts";
import { appendReceipt } from "../src/receipts.ts";
import { recordTaskOutcome } from "../src/task-outcomes.ts";
import { RuntimeSettingsStore } from "../src/runtime-settings.ts";
import type { RunReceipt } from "../src/types.ts";
import type { TaskOutcomeRow } from "../src/task-outcomes.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(dir);
	return dir;
}

function receipt(agentId: string, overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		agentId,
		name: agentId,
		repo: "repo",
		runId: `${agentId}-run`,
		startedAt: Date.now() - 1000,
		endedAt: Date.now(),
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		filesTouched: [],
		costUsd: 0.5,
		...overrides,
	};
}

function outcomeRow(agentId: string, model: string, outcome: TaskOutcomeRow["outcome"], overrides: Partial<TaskOutcomeRow> = {}): TaskOutcomeRow {
	return {
		agentId,
		routing: { mode: "tdd", tier: "heavy" },
		model,
		costUsd: 1.2,
		outcome,
		source: "land",
		ts: Date.now(),
		...overrides,
	};
}

/** Baseline "sonnet" control group (b1..b5): 4 landed, 1 rejected — mergeRate 0.8 (deliberately NOT
 *  saturated, so the auto-champion cell is `reproducible` against itself). Flagged "opus" cohort
 *  (f1..f5) is passed with its own outcome rows per test — every unit also gets a receipt stamping a
 *  CONFIRMED-delivered `membrane:verdict-first` flag, which is what `flaggedAgentIds` keys on. */
async function seedBaseline(stateDir: string): Promise<void> {
	for (let i = 1; i <= 5; i++) {
		const outcome: TaskOutcomeRow["outcome"] = i <= 4 ? "landed" : "rejected";
		await recordTaskOutcome(stateDir, outcomeRow(`b${i}`, "sonnet", outcome));
	}
}

async function seedFlaggedReceipts(stateDir: string, agentIds: string[]): Promise<void> {
	for (const id of agentIds) {
		await appendReceipt(stateDir, receipt(id, { efficiencyFlags: ["membrane:verdict-first"] }));
	}
}

function population(agentIds: string[], model: string): { agentId: string; taskClass: { mode: string; tier: string }; model?: string }[] {
	return agentIds.map((agentId) => ({ agentId, taskClass: { mode: "tdd", tier: "heavy" }, model }));
}

test("membraneBreakerCadence: a real degraded flagged cohort trips the breaker and hard-disables the setting", async () => {
	const stateDir = await tmpDir("membrane-cadence-trip-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	await seedBaseline(stateDir); // sonnet: 4/5 landed = 0.8 mergeRate
	const flaggedIds = ["f1", "f2", "f3", "f4", "f5"];
	for (let i = 1; i <= 5; i++) {
		// opus (flagged): 3/5 landed = 0.6 mergeRate — a 0.2pt drop, past MEMBRANE_BREAKER_MIN_EDGE (0.1)
		const outcome: TaskOutcomeRow["outcome"] = i <= 3 ? "landed" : "rejected";
		await recordTaskOutcome(stateDir, outcomeRow(`f${i}`, "opus", outcome));
	}
	await seedFlaggedReceipts(stateDir, flaggedIds);

	const pop = [...population(["b1", "b2", "b3", "b4", "b5"], "sonnet"), ...population(flaggedIds, "opus")];
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	expect(event).toBeDefined();
	expect(event?.summary).toContain("tdd:heavy");
	expect(event?.detail).toMatch(/mergeRate dropped/);

	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(false);
});

test("membraneBreakerCadence: a 5-unit flagged cohort with 0 lands trips against a healthy unflagged baseline (round-2 review fix)", async () => {
	// The catastrophic case the round-2 review found structurally inert: the flagged cohort collapses
	// into a single-cell matrix doc whose "champion" is itself, so a mergeRate-0 cohort's OWN
	// `reproducible` bit was always false (self-compared variance at a saturated 0 is false) — the
	// breaker could never trip on a total-failure cohort. Fixed by comparing the flagged cell directly
	// against the UNFLAGGED baseline champion instead of gating on either cell's self-doc bit.
	const stateDir = await tmpDir("membrane-cadence-zero-lands-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	await seedBaseline(stateDir); // sonnet: 4/5 landed = 0.8 mergeRate, healthy
	const flaggedIds = ["f1", "f2", "f3", "f4", "f5"];
	for (let i = 1; i <= 5; i++) {
		// opus (flagged): 0/5 landed — every single unit rejected
		await recordTaskOutcome(stateDir, outcomeRow(`f${i}`, "opus", "rejected"));
	}
	await seedFlaggedReceipts(stateDir, flaggedIds);

	const pop = [...population(["b1", "b2", "b3", "b4", "b5"], "sonnet"), ...population(flaggedIds, "opus")];
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	expect(event).toBeDefined();
	expect(event?.summary).toContain("tdd:heavy");
	expect(event?.detail).toMatch(/mergeRate dropped/);

	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(false);
});

test("membraneBreakerCadence: no comparable baseline when the unflagged population alone is sample-insufficient (baseline excludes flagged agentIds)", async () => {
	// Round-2 review fix: the baseline must be the UNFLAGGED auto-champion — computed with flagged
	// agentIds excluded, not a champion computed over the unfiltered fleet. Seed only 2 unflagged
	// "sonnet" units (below task-class-matrix.ts's MIN_SAMPLES=3) and a large, badly-degraded flagged
	// "opus" cohort. If the baseline were computed over the UNFILTERED population, "opus" (n=8,
	// sample-sufficient) would become the default champion by elimination — and the flagged cell (built
	// from the SAME underlying agentIds under the sentinel model) would then be compared against itself,
	// a degenerate "healthy" read no matter how badly the cohort is actually doing. Excluding flagged
	// agentIds correctly leaves no sample-sufficient unflagged champion, so the check must report
	// "no signal yet" (undefined, no state change) instead of a false-healthy self-comparison.
	const stateDir = await tmpDir("membrane-cadence-baseline-excl-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	// Only 2 unflagged "sonnet" units — below MIN_SAMPLES (3), never sample-sufficient on its own.
	await recordTaskOutcome(stateDir, outcomeRow("b1", "sonnet", "landed"));
	await recordTaskOutcome(stateDir, outcomeRow("b2", "sonnet", "landed"));

	const flaggedIds = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
	for (const id of flaggedIds) {
		await recordTaskOutcome(stateDir, outcomeRow(id, "opus", "rejected")); // opus: 0/8 landed, badly degraded
	}
	await seedFlaggedReceipts(stateDir, flaggedIds);

	const pop = [...population(["b1", "b2"], "sonnet"), ...population(flaggedIds, "opus")];
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	expect(event).toBeUndefined();
	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(true);
});

test("membraneBreakerCadence: a landed-and-reaped flagged unit still counts toward the cohort (history, not live-roster-only)", async () => {
	// Round-2 review fix: the cohort used to be the LIVE roster intersected with flagged agentIds, so a
	// flagged unit that already landed and was reaped off the roster dropped out entirely. With
	// MEMBRANE_BREAKER_MIN_UNITS=5, a slow trickle of flagged units landing one at a time could never
	// accumulate 5 concurrently-live units even with plenty of degraded history. Here only 3 of the 5
	// flagged units are still in the live roster/population passed in; the other 2 exist ONLY as
	// task-outcomes history rows (as a reaped unit would) — the cohort must still reach 5 and trip.
	const stateDir = await tmpDir("membrane-cadence-history-cohort-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	await seedBaseline(stateDir); // sonnet: 4/5 landed = 0.8 mergeRate
	const flaggedIds = ["f1", "f2", "f3", "f4", "f5"];
	for (let i = 1; i <= 5; i++) {
		await recordTaskOutcome(stateDir, outcomeRow(`f${i}`, "opus", "rejected")); // opus: 0/5 landed
	}
	await seedFlaggedReceipts(stateDir, flaggedIds);

	// Only f1-f3 are still "live" (present in the population passed to membraneBreakerCadence); f4/f5
	// are reaped — history-only, exactly like a landed-and-cleaned-up unit.
	const liveFlagged = ["f1", "f2", "f3"];
	const pop = [...population(["b1", "b2", "b3", "b4", "b5"], "sonnet"), ...population(liveFlagged, "opus")];
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	expect(event).toBeDefined();
	expect(event?.detail).toMatch(/mergeRate dropped/);
	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(false);
});

test("membraneBreakerCadence: a healthy flagged cohort leaves the setting untouched", async () => {
	const stateDir = await tmpDir("membrane-cadence-healthy-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	await seedBaseline(stateDir); // sonnet: 4/5 landed = 0.8 mergeRate
	const flaggedIds = ["f1", "f2", "f3", "f4", "f5"];
	for (let i = 1; i <= 5; i++) {
		// opus (flagged): ALSO 4/5 landed = 0.8 — matches baseline, no degradation
		const outcome: TaskOutcomeRow["outcome"] = i <= 4 ? "landed" : "rejected";
		await recordTaskOutcome(stateDir, outcomeRow(`f${i}`, "opus", outcome));
	}
	await seedFlaggedReceipts(stateDir, flaggedIds);

	const pop = [...population(["b1", "b2", "b3", "b4", "b5"], "sonnet"), ...population(flaggedIds, "opus")];
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	expect(event).toBeUndefined();
	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(true);
});

test("membraneBreakerCadence: no flagged cohort yet (no membrane receipts on disk) is a no-op", async () => {
	const stateDir = await tmpDir("membrane-cadence-noflags-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	await seedBaseline(stateDir);
	const pop = population(["b1", "b2", "b3", "b4", "b5"], "sonnet");
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	expect(event).toBeUndefined();
	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(true);
});

test("membraneBreakerCadence: a mixed-identity flagged unit is excluded from the cohort (concern 01 rule)", async () => {
	const stateDir = await tmpDir("membrane-cadence-mixed-");
	const store = new RuntimeSettingsStore(stateDir);
	await store.setFeatureFlag("OMP_SQUAD_MEMBRANE_PROFILES", true);

	await seedBaseline(stateDir);
	// Only 4 flagged units — 1 short of MEMBRANE_BREAKER_MIN_UNITS (5) — plus one "mixed" unit that must
	// NOT count toward the cohort even though it'd otherwise bring the total to 5.
	const flaggedIds = ["f1", "f2", "f3", "f4"];
	for (let i = 1; i <= 4; i++) {
		await recordTaskOutcome(stateDir, outcomeRow(`f${i}`, "opus", "rejected")); // badly degraded
	}
	await seedFlaggedReceipts(stateDir, flaggedIds);
	// mixed: two receipts for the same agentId with disagreeing efficiencyFlags
	await appendReceipt(stateDir, receipt("mixed1", { runId: "mixed1-run-1", efficiencyFlags: ["membrane:verdict-first"] }));
	await appendReceipt(stateDir, receipt("mixed1", { runId: "mixed1-run-2", efficiencyFlags: [] }));
	await recordTaskOutcome(stateDir, outcomeRow("mixed1", "opus", "rejected"));

	const pop = [...population(["b1", "b2", "b3", "b4", "b5"], "sonnet"), ...population([...flaggedIds, "mixed1"], "opus")];
	const event = await membraneBreakerCadence(stateDir, pop, { mode: "tdd", tier: "heavy" }, { store });

	// Below MEMBRANE_BREAKER_MIN_UNITS (5) once "mixed1" is correctly excluded — never trips.
	expect(event).toBeUndefined();
	const states = await store.states();
	expect(states.find((f) => f.key === "OMP_SQUAD_MEMBRANE_PROFILES")?.enabled).toBe(true);
});
