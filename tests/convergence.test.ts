/**
 * Convergence state machine (Epic 7, leaf 02) — drives src/convergence.ts's `runToConvergence`
 * with fake `ConvergenceDeps` (never touches a real planner/validator/fleet). Covers a converging
 * fixture, a diverging (regression) fixture, the budget cap, and the low-confidence escalation —
 * exactly the four scenarios DESIGN.md §3's contraction guarantees promise.
 */

import { describe, expect, test } from "bun:test";
import { runToConvergence, type ConvergenceDeps, type DispatchOutcome, type PlanFrontier } from "../src/convergence.ts";
import type { VerifiedState } from "../src/types.ts";

function initialState(overrides: Partial<VerifiedState> = {}): VerifiedState {
	return {
		goalId: "plans/demo",
		iteration: 0,
		gap: Infinity,
		epsilon: 0,
		pendingEscalation: false,
		budget: { spent: 0, cap: 100 },
		decision: "continue",
		updatedAt: 0,
		...overrides,
	};
}

function baseDeps(overrides: Partial<ConvergenceDeps> = {}): ConvergenceDeps {
	const written: VerifiedState[] = [];
	return {
		plan: async (): Promise<PlanFrontier> => ({ ids: ["unit-1"] }),
		dispatch: async (): Promise<DispatchOutcome> => ({ settled: true }),
		validate: async () => ({ gap: 0, confidence: 1, failures: [] }),
		ratchet: () => ({ allow: true, newRegressions: [] }),
		writeOracle: async (s: VerifiedState) => {
			written.push(s);
		},
		confidenceFloor: 0.4,
		budgetCap: 100,
		epsilon: 0,
		...overrides,
	};
}

describe("runToConvergence", () => {
	test("converging fixture: gap 3,2,1,0 → converged, writeOracle captures 4 non-increasing-gap states", async () => {
		const gaps = [3, 2, 1, 0];
		let call = 0;
		const written: VerifiedState[] = [];
		const deps = baseDeps({
			validate: async () => ({ gap: gaps[call++] ?? 0, confidence: 1, failures: [] }),
			writeOracle: async (s) => {
				written.push(s);
			},
		});
		const terminal = await runToConvergence(initialState(), deps);
		expect(terminal.decision).toBe("converged");
		expect(terminal.gap).toBe(0);
		expect(written.length).toBe(4);
		expect(written.map((s) => s.gap)).toEqual([3, 2, 1, 0]);
		for (let i = 1; i < written.length; i++) expect(written[i].gap).toBeLessThanOrEqual(written[i - 1].gap);
		// Terminal decision reached only on the LAST written state.
		expect(written.slice(0, 3).every((s) => s.decision === "continue")).toBe(true);
		expect(written[3].decision).toBe("converged");
	});

	test("diverging fixture: a new failure on iteration 2 ⇒ escalate, land/convergence never reached", async () => {
		let call = 0;
		const failureSets = [[], ["new-regression"]]; // iteration 1: clean; iteration 2: a new failure
		const written: VerifiedState[] = [];
		const deps = baseDeps({
			validate: async () => ({ gap: 5, confidence: 1, failures: failureSets[call++] ?? ["new-regression"] }),
			ratchet: (prev, curr) => {
				const allow = curr.every((f) => prev.includes(f));
				return { allow, newRegressions: curr.filter((f) => !prev.includes(f)) };
			},
			writeOracle: async (s) => {
				written.push(s);
			},
		});
		const terminal = await runToConvergence(initialState(), deps);
		expect(terminal.decision).toBe("escalate");
		expect(terminal.iteration).toBe(2);
		expect(written.every((s) => s.decision !== "converged")).toBe(true);
	});

	test("budget cap: budgetCap=2 with a never-closing gap ⇒ budget-exhausted after 2 iterations", async () => {
		const deps = baseDeps({ budgetCap: 2, validate: async () => ({ gap: 10, confidence: 1, failures: [] }) });
		const terminal = await runToConvergence(initialState({ budget: { spent: 0, cap: 2 } }), deps);
		expect(terminal.decision).toBe("budget-exhausted");
		expect(terminal.iteration).toBe(2);
		expect(terminal.budget.spent).toBe(2);
	});

	test("low confidence: confidence < confidenceFloor ⇒ pendingEscalation=true, decision=escalate", async () => {
		const deps = baseDeps({ confidenceFloor: 0.4, validate: async () => ({ gap: 5, confidence: 0.1, failures: [] }) });
		const terminal = await runToConvergence(initialState(), deps);
		expect(terminal.decision).toBe("escalate");
		expect(terminal.pendingEscalation).toBe(true);
	});

	test("a single already-converged initial state runs zero iterations", async () => {
		let calls = 0;
		const deps = baseDeps({
			plan: async () => {
				calls++;
				return { ids: [] };
			},
		});
		const terminal = await runToConvergence(initialState({ decision: "converged", gap: 0 }), deps);
		expect(calls).toBe(0);
		expect(terminal.decision).toBe("converged");
	});
});
