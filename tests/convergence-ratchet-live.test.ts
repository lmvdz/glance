/**
 * The convergence loop's no-regression ratchet, now LIVE (Epic 7 S3, formerly dormant). Drives the
 * real `runIteration` with the REAL `ratchet` (src/convergence-ratchet.ts → land.ts's
 * decideRegressionGate) over caller-controlled suite failure sets, plus the failures sidecar that
 * carries the prior turn's set across the `--once` process boundary without touching the pinned oracle.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runIteration, type ConvergenceDeps, type DispatchOutcome, type PlanFrontier } from "../src/convergence.ts";
import { ratchet } from "../src/convergence-ratchet.ts";
import { clearFailures, readFailures, writeFailures } from "../src/convergence-oracle.ts";
import type { VerifiedState } from "../src/types.ts";

const state = (over: Partial<VerifiedState> = {}): VerifiedState => ({
	goalId: "plans/demo",
	iteration: 0,
	gap: Number.POSITIVE_INFINITY,
	epsilon: 0,
	pendingEscalation: false,
	budget: { spent: 0, cap: 100 },
	decision: "continue",
	updatedAt: 0,
	...over,
});

// validate returns a caller-controlled failure set; the REAL ratchet decides monotonicity.
const deps = (failures: string[], gap = 1): ConvergenceDeps => ({
	plan: async (): Promise<PlanFrontier> => ({ ids: ["u"] }),
	dispatch: async (): Promise<DispatchOutcome> => ({ settled: true }),
	validate: async () => ({ gap, confidence: 1, failures }),
	ratchet,
	writeOracle: async () => {},
	confidenceFloor: 0.4,
	budgetCap: 100,
	epsilon: 0,
});

describe("ratchet is live — turn-over-turn no-regression", () => {
	test("baseline turn (prevFailures null): a RED starting tree does NOT escalate", async () => {
		const { next, failures } = await runIteration(state(), deps(["A", "B"]), null);
		expect(next.decision).toBe("continue"); // baseline recorded, not treated as a regression
		expect(failures).toEqual(["A", "B"]); // and handed forward for the next turn's ratchet
	});

	test("a NEW failure vs the prior turn breaks monotonicity → escalate", async () => {
		const { next } = await runIteration(state({ iteration: 1 }), deps(["A", "B", "C"]), ["A", "B"]);
		expect(next.decision).toBe("escalate"); // "C" is a strictly-new regression
	});

	test("a strictly shrinking failure set is progress → continue", async () => {
		const { next } = await runIteration(state({ iteration: 2 }), deps(["A"]), ["A", "B"]);
		expect(next.decision).toBe("continue"); // "B" got fixed, nothing new — allowed
	});

	test("green + gap 0 with no regression → converged", async () => {
		const { next } = await runIteration(state({ iteration: 3 }), deps([], 0), []);
		expect(next.decision).toBe("converged");
	});
});

describe("failures sidecar — cross-process carry, oracle schema untouched", () => {
	test("null when absent (baseline), round-trips, and clears", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conv-fail-"));
		try {
			expect(await readFailures(dir)).toBeNull(); // no sidecar yet = baseline turn
			await writeFailures(["A", "B"], dir);
			expect(await readFailures(dir)).toEqual(["A", "B"]);
			await clearFailures(dir);
			expect(await readFailures(dir)).toBeNull(); // dropped on terminal so the next goal re-baselines
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
