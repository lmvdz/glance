/**
 * Ratchet dep (Epic 7, leaf 03) — the per-iteration no-regression check `src/convergence.ts`
 * injects as `deps.ratchet`. Forbids iteration N+1 from introducing a failure N did not have, by
 * delegating to the EXACT monotonicity logic the post-merge regression gate already trusts
 * (`decideRegressionGate`/`extractGateFailures`, `src/land.ts:219,209`) — so the loop's "never undo
 * a verified gain" guarantee is the same one landing already enforces (DESIGN.md §3).
 *
 * Pure over failure sets/strings — no test suite is run here; whoever drives an iteration (leaf 02's
 * caller) passes the failure sets or raw suite output in.
 */

import { decideRegressionGate, extractGateFailures } from "./land.ts";

export interface RatchetResult {
	allow: boolean;
	newRegressions: string[];
}

/** Thin wrapper delegating to `decideRegressionGate` — the exact function leaf 02 injects as
 *  `deps.ratchet`. Allows when no failure in `currFailures` is strictly new vs `prevFailures`;
 *  a pre-existing red baseline is fine, and a failure that got FIXED is always allowed. */
export function ratchet(prevFailures: Iterable<string>, currFailures: Iterable<string>): RatchetResult {
	return decideRegressionGate(prevFailures, currFailures);
}

/** Convenience for callers holding raw suite text rather than pre-parsed failure sets: extracts
 *  each output's failure set via `extractGateFailures` first, then applies the same ratchet. */
export function ratchetFromOutput(prevOutput: string, currOutput: string): RatchetResult {
	return ratchet(extractGateFailures(prevOutput), extractGateFailures(currOutput));
}
