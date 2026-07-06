/**
 * Convergence state machine (Epic 7, leaf 02) — the iteration engine over injected deps:
 * `plan → dispatch → validate → ratchet → decide`, emitting a fresh `VerifiedState` (via
 * `writeOracle`) each cycle. Pure policy, no live daemon — modeled directly on `OrchestratorDeps`
 * (`src/orchestrator.ts:24`): every external effect is a function on `ConvergenceDeps`, so the
 * loop runs headless with fakes and unit-tests without a real planner/validator/fleet.
 *
 * `runIteration` is the single reusable unit: `runToConvergence` (the in-process/fixture driver)
 * loops it while `decision === "continue"`; the real Stop-hook-driven production path (leaf 04/05)
 * drives the SAME `runIteration` one turn at a time from the live session — see DESIGN.md §2.
 *
 * Prior-iteration failures for the ratchet are carried in a closure captured by `runToConvergence`
 * (not on `VerifiedState` itself — the oracle is the cross-process contract with the bash hook and
 * DESIGN.md §1 pins its schema exactly; failures are an internal-to-this-module carry, not part of
 * that contract). Documented here per leaf 02's "pick one and document it".
 */

import type { VerifiedState } from "./types.ts";

/** Minimal frontier shape: the id list of open units the planner emitted this cycle. The real
 *  richness (concern DAGs, per-unit metadata) lives in Epic 1; this state machine only needs
 *  "how many/which units are left", not their content. */
export interface PlanFrontier {
	ids: string[];
}

/** Minimal dispatch result: whether the frontier's unit(s) settled (finished, one way or another)
 *  this cycle. The real richness (per-agent outcomes) lives in Epic 2/the existing fleet. */
export interface DispatchOutcome {
	settled: boolean;
}

/** External edges one convergence cycle drives through — all injected so the state machine runs
 *  headless with fakes (mirrors `OrchestratorDeps`). */
export interface ConvergenceDeps {
	/** Epic 1 planner adapter: emit/refresh the frontier against verified state. */
	plan: (goalId: string, verified: VerifiedState) => Promise<PlanFrontier>;
	/** Epic 2/existing fleet: dispatch the frontier's next unit(s), resolve when they settle. */
	dispatch: (frontier: PlanFrontier) => Promise<DispatchOutcome>;
	/** Epic 3 validator adapter: score output vs declared acceptanceCriteria → gap + confidence. */
	validate: (goalId: string) => Promise<{ gap: number; confidence: number; failures: string[] }>;
	/** Leaf 03: no-regression check comparing prior-iteration failures vs current. */
	ratchet: (prev: string[], curr: string[]) => { allow: boolean; newRegressions: string[] };
	/** Leaf 01: persist the verified-state artifact each cycle. */
	writeOracle: (s: VerifiedState) => Promise<void>;
	/** Epic 5 confidence exit threshold; below → pendingEscalation=true, STOP as a proposal. */
	confidenceFloor: number;
	budgetCap: number;
	epsilon: number;
}

/**
 * One convergence cycle: plan → dispatch → validate → ratchet → decide → persist. Never throws by
 * contract of its deps (a dep that can fail should resolve to a safe value — e.g. validate()
 * returning a high gap/low confidence — rather than reject; this function does not itself catch).
 */
export async function runIteration(state: VerifiedState, deps: ConvergenceDeps, prevFailures: string[] | null): Promise<{ next: VerifiedState; failures: string[] }> {
	const frontier = await deps.plan(state.goalId, state);
	await deps.dispatch(frontier);
	const { gap, confidence, failures } = await deps.validate(state.goalId);
	// `prevFailures === null` is the BASELINE turn (no prior set to compare) — record this turn's
	// failures without ratcheting, so a red starting tree isn't mistaken for a regression. Every later
	// turn ratchets against the previous turn: a failure that's strictly NEW breaks monotonicity.
	const { allow } = prevFailures === null ? { allow: true } : deps.ratchet(prevFailures, failures);

	const spent = state.budget.spent + 1;
	let decision: VerifiedState["decision"];
	let pendingEscalation = false;
	if (!allow) {
		decision = "escalate"; // a regression appeared — monotonicity broken, hand to human
	} else if (confidence < deps.confidenceFloor) {
		decision = "escalate";
		pendingEscalation = true; // a low-confidence proposal is waiting on a human, not a hard failure
	} else if (gap <= deps.epsilon) {
		decision = "converged";
	} else if (spent >= deps.budgetCap) {
		decision = "budget-exhausted";
	} else {
		decision = "continue";
	}

	const next: VerifiedState = {
		...state,
		iteration: state.iteration + 1,
		gap,
		pendingEscalation,
		budget: { ...state.budget, spent },
		decision,
		updatedAt: Date.now(),
	};
	await deps.writeOracle(next);
	return { next, failures };
}

/** Drive `runIteration` to a terminal decision, carrying failures forward cycle-to-cycle in a
 *  closure. This is the in-process/fixture driver (leaf 05's `--fixture` path); the real
 *  Stop-hook-driven production loop calls `runIteration` once per turn instead (DESIGN.md §2). */
export async function runToConvergence(initial: VerifiedState, deps: ConvergenceDeps): Promise<VerifiedState> {
	let state = initial;
	// First iteration is the baseline (null → no ratchet); thereafter carry the prior turn's failures.
	let failures: string[] | null = null;
	while (state.decision === "continue") {
		const result = await runIteration(state, deps, failures);
		state = result.next;
		failures = result.failures;
	}
	return state;
}
