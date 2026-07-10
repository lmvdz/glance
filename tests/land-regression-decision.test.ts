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
	// Duration values still collapse to the SAME placeholder (`<dur>`), so different literal
	// durations for the same underlying failure still compare equal (never a new regression) — only
	// "c", present in merged and absent from base, is genuinely new. Substitution (not deletion) is
	// why the identity string itself now carries "<dur>" rather than nothing; that literal text is
	// irrelevant to the comparison as long as it's the SAME placeholder on both sides, which it is.
	expect(decideRegressionGate(["b [1.20ms]", "a [3ms]", "b [4ms]"], ["c [9.1ms]", "b [2.30ms]", "a [1s]"])).toEqual({
		allow: false,
		newRegressions: ["c <dur>"],
	});
});

test("extractGateFailures parses bun fail lines", () => {
	const output = "ok\n(fail) tests/auth.test.ts > login [1.23ms]\n(fail) tests/api.test.ts > returns 500 [2s]\n";
	// The trailing duration is now SUBSTITUTED with a placeholder, not deleted (fail-open fix #2) —
	// the identity string carries "<dur>" instead of nothing, but two different duration VALUES for
	// the same failure still normalize to the same identity (see the follow-up-4 tests below).
	expect(extractGateFailures(output)).toEqual(["tests/api.test.ts > returns 500 <dur>", "tests/auth.test.ts > login <dur>"]);
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
	expect(extractGateFailures(output)).toEqual(["tests/api.test.ts > returns 500 <dur>", "tests/auth.test.ts > login <dur>"]);
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

test("fail-open fix, helper level: base failure A and merged failure B differing only in an interior hex id is REFUSED, not silently allowed", () => {
	// NOTE: this is the extractGateFailures/decideRegressionGate HELPER path, not a real
	// applyRegressionGate/verifyMerged integration test — a blind review correctly pointed out a
	// prior version of this test was mislabeled "gate level" despite never touching a real gate run.
	// See tests/land-regression-gate.test.ts for the real integration-level equivalent (a genuine
	// git repo + gate script driven through `landAgent`/`applyRegressionGate`/`verifyMerged`).
	const baseFailures = extractGateFailures("object a1b2c3d missing\n");
	const mergedFailures = extractGateFailures("object e4f5a6b missing\n");
	const decision = decideRegressionGate(baseFailures, mergedFailures);
	expect(decision.allow).toBe(false); // must REFUSE — a real regression, not a red-baseline re-merge
	expect(decision.newRegressions).toEqual(mergedFailures);
});

// ─── Fail-open fix #2 (a second blind cross-lineage review): normalization must SUBSTITUTE a stable
// placeholder for a volatile token, never DELETE it — deletion of a whole-line volatile token (a
// failure message that IS, in its entirety, a timestamp or a duration) produced an EMPTY identity,
// which `uniqueSortedFailures` used to filter out of the compared set entirely. A failure that
// vanishes from the set is the sharpest possible fail-open: base=[] and merged=[] compare equal no
// matter what actually happened. These tests pin the substitution scheme and the never-empty
// invariant it guarantees.

test("fail-open fix #2: a failure message that is ENTIRELY a leading timestamp normalizes to a non-empty placeholder, and still REFUSES against a green base", () => {
	const identity = extractGateFailures("2026-07-09T12:00:01.123Z\n");
	expect(identity).toEqual(["<ts>"]); // non-empty — never silently dropped from the set
	const decision = decideRegressionGate([], identity); // green base vs. this genuinely-failing merge
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(["<ts>"]);
});

test("fail-open fix #2: a failure message that is ENTIRELY a trailing bracketed duration normalizes to a non-empty placeholder, and still REFUSES against a green base", () => {
	const identity = extractGateFailures("[196.72s]\n");
	expect(identity).toEqual(["<dur>"]);
	const decision = decideRegressionGate([], identity);
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(["<dur>"]);
});

test("fail-open fix #2: a leading token that is CLOCK-shaped but is genuine message content (not a log prefix) still collapses to <ts>, but the REST of the line keeps two different messages apart", () => {
	// The normalizer can't tell "a log-line timestamp prefix" from "a test name that happens to start
	// with clock-shaped digits" — it strips both the same way. That's fine ONLY because it never
	// deletes: the placeholder preserves enough structure that two genuinely different messages whose
	// leading token both happen to look like a timestamp still compare unequal on the remainder.
	const base = extractGateFailures("12:00:00 alpha check failed\n");
	const merged = extractGateFailures("12:00:00 beta check failed\n");
	expect(base).toEqual(["<ts> alpha check failed"]);
	expect(merged).toEqual(["<ts> beta check failed"]);
	expect(base).not.toEqual(merged);
	const decision = decideRegressionGate(base, merged);
	expect(decision.allow).toBe(false);
	expect(decision.newRegressions).toEqual(merged);
});

test("fail-open fix #2: a message that is ONLY a /tmp path must never collide with an unrelated real message", () => {
	const base = extractGateFailures("/tmp/build-a/scratch.log\n");
	const merged = extractGateFailures("assertion failed\n");
	expect(base).toEqual(["<tmp>"]);
	expect(merged).toEqual(["assertion failed"]);
	expect(base).not.toEqual(merged);
	const decision = decideRegressionGate(base, merged);
	expect(decision.allow).toBe(false); // a genuinely new, unrelated failure — must refuse
	expect(decision.newRegressions).toEqual(merged);
});

test("design choice: two /tmp paths differing only in the sandbox directory name ARE treated as the same failure (same failure, different sandbox)", () => {
	// Documented trade-off (rank 3 of the review): /tmp/build-a/x.ts vs /tmp/build-b/x.ts failing the
	// SAME way is the same underlying failure surfacing in two different worktree sandboxes — that
	// should collapse. A message that is ONLY a path (the test above) is the case that must NOT
	// collapse into something else; collapsing two *equivalent* paths is intentional, not a regression.
	const base = extractGateFailures("/tmp/build-a/x.ts: syntax error\n");
	const merged = extractGateFailures("/tmp/build-b/x.ts: syntax error\n");
	expect(base).toEqual(merged);
	expect(decideRegressionGate(base, merged)).toEqual({ allow: true, newRegressions: [] });
});

test("design note: decideRegressionGate compares SETS, not multisets — multiplicity is deliberately ignored", () => {
	// Three occurrences of the same identity in the base and one in the merged set compare equal; the
	// gate answers "did a NEW kind of failure appear", not "did the count change". This is intentional
	// (rank 7 of the review) — flagging a flaky test that fails 3/3 times on base and 1/1 on merged as
	// a "regression" would be a worse false-positive than the count-blindness it trades for.
	expect(decideRegressionGate(["a", "a", "a"], ["a"])).toEqual({ allow: true, newRegressions: [] });
	expect(decideRegressionGate(["a"], ["a", "a", "a"])).toEqual({ allow: true, newRegressions: [] });
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
