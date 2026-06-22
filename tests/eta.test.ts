/**
 * ETA — pure progress-rate extrapolation. done/total/elapsed are passed directly (no clock/agent state),
 * so the boundary cases (no progress, already complete, zero elapsed) are deterministic.
 */

import { expect, test } from "bun:test";
import { estimateEta } from "../src/eta.ts";

test("extrapolates remaining time from the completed rate", () => {
	expect(estimateEta(2, 6, 10_000)).toBe(20_000); // 2 done in 10s ⇒ ~5s each ⇒ 4 left ≈ 20s
	expect(estimateEta(3, 4, 9_000)).toBe(3_000); // 3 in 9s ⇒ 1 left ≈ 3s
});

test("undefined when it can't be estimated", () => {
	expect(estimateEta(0, 5, 10_000)).toBeUndefined(); // no progress yet → no rate
	expect(estimateEta(5, 5, 10_000)).toBeUndefined(); // already complete
	expect(estimateEta(6, 5, 10_000)).toBeUndefined(); // over-complete (guard)
	expect(estimateEta(2, 0, 10_000)).toBeUndefined(); // nothing to do
	expect(estimateEta(2, 6, 0)).toBeUndefined(); // no elapsed time
});
