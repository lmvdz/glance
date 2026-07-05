/**
 * Ratchet dep (Epic 7, leaf 03) — src/convergence-ratchet.ts is a thin wrapper over land.ts's
 * decideRegressionGate/extractGateFailures; these tests pin the exact allow/block contract
 * DESIGN.md §3 promises the convergence state machine.
 */

import { describe, expect, test } from "bun:test";
import { ratchet, ratchetFromOutput } from "../src/convergence-ratchet.ts";

describe("ratchet", () => {
	test("no new failure ⇒ allow", () => {
		expect(ratchet(["a"], ["a"])).toEqual({ allow: true, newRegressions: [] });
	});

	test("a new failure blocks", () => {
		expect(ratchet(["a"], ["a", "b"])).toEqual({ allow: false, newRegressions: ["b"] });
	});

	test("a fixed failure is always allowed", () => {
		const result = ratchet(["a", "b"], ["a"]);
		expect(result.allow).toBe(true);
		expect(result.newRegressions).toEqual([]);
	});

	test("empty base, empty current ⇒ allow (green baseline stays green)", () => {
		expect(ratchet([], [])).toEqual({ allow: true, newRegressions: [] });
	});

	test("empty base, one new failure ⇒ block", () => {
		expect(ratchet([], ["c"])).toEqual({ allow: false, newRegressions: ["c"] });
	});
});

describe("ratchetFromOutput", () => {
	test("reduces two raw gate outputs to the same allow/block decision via extractGateFailures", () => {
		const prevOutput = "(fail) suite-a\n(fail) suite-b";
		const sameOutput = "(fail) suite-b\n(fail) suite-a"; // order-insensitive, no new failure
		expect(ratchetFromOutput(prevOutput, sameOutput)).toEqual({ allow: true, newRegressions: [] });

		const currWithNew = "(fail) suite-a\n(fail) suite-b\n(fail) suite-c";
		expect(ratchetFromOutput(prevOutput, currWithNew)).toEqual({ allow: false, newRegressions: ["suite-c"] });
	});
});
