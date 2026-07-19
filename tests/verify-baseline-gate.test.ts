/**
 * Executor-level proof that `runCommand`'s base-diff wiring (postmortem-gate-fixes) only turns a
 * failing verify goalGate node's outcome into "succeeded" when EVERY failure it saw already fails
 * on the unit's base state — and never does so for a genuinely NEW failure, or when the base run
 * itself couldn't be trusted (fail-closed).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BaselineResult } from "../src/workflow/verify-baseline.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

const prevFlag = process.env.OMP_SQUAD_VERIFY_BASE_DIFF;
beforeEach(() => {
	delete process.env.OMP_SQUAD_VERIFY_BASE_DIFF; // default ON for every test in this file
});
afterEach(() => {
	if (prevFlag === undefined) delete process.env.OMP_SQUAD_VERIFY_BASE_DIFF;
	else process.env.OMP_SQUAD_VERIFY_BASE_DIFF = prevFlag;
});

const goalGateNode: WorkflowNode = { id: "verify", kind: "command", label: "Verify", script: "bun test", goalGate: true, attrs: {} };
const nonGoalGateNode: WorkflowNode = { id: "codefix", kind: "command", label: "Codefix", script: "bun run fix", attrs: {} };
const ctx = (): RunContext => ({ goal: "g", vars: {} });

function exec(opts: {
	execCommand: (script: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
	resolveBaselineFailures?: (script: string) => Promise<BaselineResult | null>;
}): SingleAgentExecutor {
	return new SingleAgentExecutor({
		cwd: ".",
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand: opts.execCommand,
		resolveBaselineFailures: opts.resolveBaselineFailures,
	});
}

test("failing set is a SUBSET of the base's failing set -> node outcome flips to succeeded", async () => {
	const execCommand = async () => ({
		code: 1,
		stdout: "1 pass\n1 fail\n(fail) tests/flaky.test.ts > sometimes fails\n",
		stderr: "",
	});
	const resolveBaselineFailures = async (): Promise<BaselineResult> => ({
		failures: ["tests/flaky.test.ts > sometimes fails", "tests/other.test.ts > also pre-existing"],
		unrunnable: null,
		baseRef: "abcdef0123456789",
	});
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("succeeded");
	expect(res.text).toContain("base-diff");
	expect(res.text).toContain("gate passed");
	expect(res.text).toContain("abcdef01"); // short baseRef
	expect(res.text).toContain("0 introduced by this unit");
});

test("a NEW failure not present on base -> outcome stays failed, and the new failure is surfaced in the steer text", async () => {
	const execCommand = async () => ({
		code: 1,
		stdout: "0 pass\n2 fail\n(fail) tests/flaky.test.ts > sometimes fails\n(fail) tests/newbug.test.ts > introduced by this unit\n",
		stderr: "",
	});
	const resolveBaselineFailures = async (): Promise<BaselineResult> => ({
		failures: ["tests/flaky.test.ts > sometimes fails"],
		unrunnable: null,
		baseRef: "abcdef0123456789",
	});
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(res.text).toContain("1 NEW failure");
	expect(res.text).toContain("tests/newbug.test.ts > introduced by this unit");
	// The new-failure header comes FIRST, ahead of the full reduced dump (which still includes the
	// pre-existing base failure too) — the fixup agent sees the signal before the noise.
	expect(res.text.indexOf("1 NEW failure")).toBeLessThan(res.text.indexOf("0 pass"));
});

test("unrunnable base -> fails CLOSED (outcome failed, never treated as everything-tolerated)", async () => {
	const execCommand = async () => ({
		code: 1,
		stdout: "1 fail\n(fail) tests/foo.test.ts > x\n",
		stderr: "",
	});
	const resolveBaselineFailures = async (): Promise<BaselineResult> => ({
		failures: [],
		unrunnable: "gate output shows an executable-resolution failure and no test ever ran — the environment lacks a binary the gate needs",
		baseRef: "abcdef0123456789",
	});
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(res.text).toContain("could not establish a base run");
	expect(res.text).toContain("blocking on the full failure set");
});

test("resolveBaselineFailures returning null (provider hard-failed) -> fails CLOSED too", async () => {
	const execCommand = async () => ({ code: 1, stdout: "(fail) tests/foo.test.ts > x\n", stderr: "" });
	const resolveBaselineFailures = async (): Promise<BaselineResult | null> => null;
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(res.text).toContain("could not establish a base run");
});

test("a PASSING verify run (exit 0) is never touched by base-diff — resolveBaselineFailures is never even called", async () => {
	let called = false;
	const execCommand = async () => ({ code: 0, stdout: "5 pass", stderr: "" });
	const resolveBaselineFailures = async (): Promise<BaselineResult | null> => {
		called = true;
		return { failures: [], unrunnable: null, baseRef: "x" };
	};
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("succeeded");
	expect(called).toBe(false);
});

test("a non-goalGate command node (e.g. codefix) is never base-diffed even when it fails", async () => {
	let called = false;
	const execCommand = async () => ({ code: 1, stdout: "(fail) tests/foo.test.ts > x\n", stderr: "" });
	const resolveBaselineFailures = async (): Promise<BaselineResult | null> => {
		called = true;
		return { failures: ["tests/foo.test.ts > x"], unrunnable: null, baseRef: "x" };
	};
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(nonGoalGateNode, ctx());
	expect(res.outcome).toBe("failed"); // unchanged — subset-of-base logic never applies to non-goalGate nodes
	expect(called).toBe(false);
});

test("no resolveBaselineFailures wired -> a failing goalGate node behaves exactly as before (unchanged legacy path)", async () => {
	const execCommand = async () => ({ code: 1, stdout: "(fail) tests/foo.test.ts > x\n", stderr: "" });
	const e = exec({ execCommand }); // no resolveBaselineFailures at all
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(res.text).not.toContain("base-diff");
});

test("OMP_SQUAD_VERIFY_BASE_DIFF=0 disables base-diff even when a provider is wired", async () => {
	process.env.OMP_SQUAD_VERIFY_BASE_DIFF = "0";
	let called = false;
	const execCommand = async () => ({ code: 1, stdout: "(fail) tests/flaky.test.ts > sometimes fails\n", stderr: "" });
	const resolveBaselineFailures = async (): Promise<BaselineResult | null> => {
		called = true;
		return { failures: ["tests/flaky.test.ts > sometimes fails"], unrunnable: null, baseRef: "x" };
	};
	const e = exec({ execCommand, resolveBaselineFailures });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed"); // would have been "succeeded" with the flag on (subset-of-base)
	expect(called).toBe(false);
});
