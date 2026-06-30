import { expect, test } from "bun:test";
import { decideRegressionGate, extractGateFailures } from "../src/land.ts";

test("green base and green merge are allowed", () => {
	expect(decideRegressionGate([], [])).toEqual({ allow: true, newRegressions: [] });
});

test("green base and merged failure blocks with that new regression", () => {
	expect(decideRegressionGate([], ["a"])).toEqual({ allow: false, newRegressions: ["a"] });
});

test("red base and same merged failure is allowed", () => {
	expect(decideRegressionGate(["a"], ["a"])).toEqual({ allow: true, newRegressions: [] });
});

test("red base and additional merged failure blocks only the new regression", () => {
	expect(decideRegressionGate(["a"], ["a", "b"])).toEqual({ allow: false, newRegressions: ["b"] });
});

test("red base can improve while staying allowed", () => {
	expect(decideRegressionGate(["a", "b"], ["a"])).toEqual({ allow: true, newRegressions: [] });
});

test("duplicates, unsorted failures, and duration suffixes normalize deterministically", () => {
	expect(decideRegressionGate(["b [1.20ms]", "a", "b"], ["c [9.1ms]", "b [2.30ms]", "c", "a [1s]"])).toEqual({
		allow: false,
		newRegressions: ["c"],
	});
});

test("extractGateFailures parses bun fail lines", () => {
	const output = "ok\n(fail) tests/auth.test.ts > login [1.23ms]\n(fail) tests/api.test.ts > returns 500 [2s]\n";
	expect(extractGateFailures(output)).toEqual(["tests/api.test.ts > returns 500", "tests/auth.test.ts > login"]);
});

test("extractGateFailures returns a conservative fallback identity for unparseable failure output", () => {
	expect(extractGateFailures("\nTypeError: boom\nstack", "bun test")).toEqual(["TypeError: boom"]);
	expect(extractGateFailures("\n", "bun test")).toEqual(["bun test"]);
});
