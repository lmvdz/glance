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
	// finding #8 (eap-borrows wave 2): the identity is now the WHOLE trimmed output, not just its first
	// line — see the two tests below for why (a first-line-only identity collided two different reds).
	expect(extractGateFailures("\nTypeError: boom\nstack", "bun test")).toEqual(["TypeError: boom\nstack"]);
	expect(extractGateFailures("\n", "bun test")).toEqual(["bun test"]);
});

test("finding #8: an UNCHANGED check/tsc-only red baseline still compares equal (never wedges a brownfield repo)", () => {
	// The exact same failing gate output on base and merged (a genuinely reproducible, unchanged
	// brownfield failure) — decideRegressionGate must still ALLOW the red-baseline re-merge.
	const output = "$ tsc --noEmit\nsrc/foo.ts(3,1): error TS2304: Cannot find name 'Bar'.\n";
	const base = extractGateFailures(output);
	const merged = extractGateFailures(output);
	expect(decideRegressionGate(base, merged)).toEqual({ allow: true, newRegressions: [] });
});

// eap-borrows follow-up 4: the whole-output fallback identity is nondeterminism-sensitive — interior
// timestamps/durations/temp paths/PIDs/hex ids differ run-to-run even when the underlying failure is
// unchanged, so base-vs-merged never compared equal on such a repo (degrading the red-baseline
// allowance to always-refuse; force-land was the only escape). These three tests reproduce that on
// CURRENT (pre-fix) code — they FAIL before `normalizeFailureIdentity` normalizes volatile tokens.
test("follow-up 4(a): the SAME logical failure with different timestamps/durations/temp-paths/pids/hex-ids compares EQUAL", () => {
	const baseOutput =
		"$ some-check\n" +
		"2026-07-09T12:00:01.123Z [worker pid 4821] wrote /tmp/omp-squad-a1b2c3d/scratch.log\n" +
		"error: assertion failed at src/foo.ts:42\n" +
		"Ran 12 tests across 3 files. [196.72s]\n";
	const mergedOutput =
		"$ some-check\n" +
		"2026-07-10T03:14:59.987Z [worker pid 9310] wrote /tmp/omp-squad-z9y8x7w/scratch.log\n" +
		"error: assertion failed at src/foo.ts:42\n" +
		"Ran 12 tests across 3 files. [204.05s]\n";
	const base = extractGateFailures(baseOutput);
	const merged = extractGateFailures(mergedOutput);
	expect(base).toEqual(merged);
	expect(decideRegressionGate(base, merged)).toEqual({ allow: true, newRegressions: [] });
});

test("follow-up 4(b): two GENUINELY different failures (different assertion) still compare UNEQUAL even once volatile tokens are stripped", () => {
	const baseOutput = "$ some-check\n2026-07-09T12:00:01.123Z [worker pid 4821] wrote /tmp/omp-squad-a1b2c3d/scratch.log\nerror: assertion failed at src/foo.ts:42\nRan 12 tests across 3 files. [196.72s]\n";
	const mergedOutput = "$ some-check\n2026-07-10T03:14:59.987Z [worker pid 9310] wrote /tmp/omp-squad-z9y8x7w/scratch.log\nerror: assertion failed at src/bar.ts:17\nRan 12 tests across 3 files. [204.05s]\n";
	const base = extractGateFailures(baseOutput);
	const merged = extractGateFailures(mergedOutput);
	expect(base).not.toEqual(merged);
	const decision = decideRegressionGate(base, merged);
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(merged);
});

test("follow-up 4(c): existing (fail)-line behavior is unchanged — bun-style fail lines still parse and de-duplicate the same way", () => {
	const output = "ok\n(fail) tests/auth.test.ts > login [1.23ms]\n(fail) tests/api.test.ts > returns 500 [2s]\n";
	expect(extractGateFailures(output)).toEqual(["tests/api.test.ts > returns 500", "tests/auth.test.ts > login"]);
});

// Fail-open fix (blind cross-lineage review of the follow-up-4 patch, db4ed56): the original patch
// stripped its volatile-token patterns ANYWHERE in a line, not just at the boilerplate positions
// (leading timestamp / trailing duration). When a gate emits no `(fail)` lines the whole trimmed output
// is a single identity token, so over-stripping could normalize two genuinely DIFFERENT failures down
// to the same string — decideRegressionGate then reads base==merged and ALLOWS a land that actually
// introduced a real regression. These reproduce the collision on the PRE-fix (db4ed56) code — verified
// by stashing this fix and re-running: both fail before the fix, pass after.
test("fail-open fix: an interior duration difference (no brackets) stays a genuinely different failure", () => {
	const base = extractGateFailures("timeout after 30s\n");
	const merged = extractGateFailures("timeout after 5s\n");
	expect(base).not.toEqual(merged);
	const decision = decideRegressionGate(base, merged);
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(merged);
});

test("fail-open fix: an interior hex object id difference stays a genuinely different failure", () => {
	const base = extractGateFailures("object a1b2c3d missing\n");
	const merged = extractGateFailures("object e4f5a6b missing\n");
	expect(base).not.toEqual(merged);
	const decision = decideRegressionGate(base, merged);
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(merged);
});

test("fail-open fix: leading timestamp still normalizes away (follow-up 4's original wedge stays fixed)", () => {
	const base = extractGateFailures("2026-07-09T12:00:01.123Z error: assertion failed at src/foo.ts:42\n");
	const merged = extractGateFailures("2026-07-10T03:14:59.987Z error: assertion failed at src/foo.ts:42\n");
	expect(base).toEqual(merged);
	expect(decideRegressionGate(base, merged)).toEqual({ allow: true, newRegressions: [] });
});

test("fail-open fix: trailing bracketed duration still normalizes away (follow-up 4's original wedge stays fixed)", () => {
	const base = extractGateFailures("error: assertion failed at src/foo.ts:42 [196.72s]\n");
	const merged = extractGateFailures("error: assertion failed at src/foo.ts:42 [204.05s]\n");
	expect(base).toEqual(merged);
	expect(decideRegressionGate(base, merged)).toEqual({ allow: true, newRegressions: [] });
});

test("fail-open fix, gate level: base failure A and merged failure B differing only in an interior hex id is REFUSED, not silently allowed", () => {
	// This is the test that proves the fail-open is closed AT THE GATE, not just in the helper: base
	// has one failure, merged has a DIFFERENT failure whose only textual difference is the hex id — the
	// exact shape a false-equality collision would silently wave through.
	const baseFailures = extractGateFailures("object a1b2c3d missing\n");
	const mergedFailures = extractGateFailures("object e4f5a6b missing\n");
	const decision = decideRegressionGate(baseFailures, mergedFailures);
	expect(decision.allow).toBe(false); // must REFUSE — a real regression, not a red-baseline re-merge
	expect(decision.newRegressions).toEqual(mergedFailures);
});

test('finding #8: two DIFFERENT check/tsc-only failures whose FIRST LINE coincides no longer collide as "the same" red', () => {
	// OLD behavior (fail-open, the residual "equal-red" hole): extractGateFailures used only the first
	// line as identity — both outputs below share the exact same first line ("$ tsc --noEmit") while
	// reporting genuinely DIFFERENT errors underneath, so the old fallback extracted the SAME single
	// token for both and decideRegressionGate read it as "same pre-existing red baseline" — silently
	// allowing a branch that introduced a real new tsc error. NEW behavior: the full-output identity
	// differs, so the merged run's failure reads as a genuinely new regression and blocks.
	const baseOutput = "$ tsc --noEmit\nsrc/foo.ts(3,1): error TS2304: Cannot find name 'Bar'.\n";
	const mergedOutput = "$ tsc --noEmit\nsrc/other.ts(9,4): error TS2322: Type 'string' is not assignable to type 'number'.\n";
	const base = extractGateFailures(baseOutput);
	const merged = extractGateFailures(mergedOutput);
	const decision = decideRegressionGate(base, merged);
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(merged);
});
