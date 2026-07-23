/**
 * Executor-level proof that `runCommand`'s base-diff wiring (postmortem-gate-fixes) only turns a
 * failing verify goalGate node's outcome into "succeeded" when EVERY failure it saw already fails
 * on the unit's base state — and never does so for a genuinely NEW failure, or when the base run
 * itself couldn't be trusted (fail-closed).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	listChangedFilesSinceBase?: (baseRef: string) => Promise<string[]>;
	hasRecordedFlakeForFile?: (file: string) => boolean;
	isolationTimeoutMs?: number;
	log?: (message: string) => void;
	cwd?: string;
}): SingleAgentExecutor {
	return new SingleAgentExecutor({
		cwd: opts.cwd ?? ".",
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand: opts.execCommand,
		resolveBaselineFailures: opts.resolveBaselineFailures,
		listChangedFilesSinceBase: opts.listChangedFilesSinceBase,
		hasRecordedFlakeForFile: opts.hasRecordedFlakeForFile,
		isolationTimeoutMs: opts.isolationTimeoutMs,
		log: opts.log,
	});
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(stderr || `git ${args.join(" ")} failed`);
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
	const e = exec({ execCommand, resolveBaselineFailures, listChangedFilesSinceBase: async () => ["tests/newbug.test.ts"] });
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(res.text).toContain("1 NEW failure");
	expect(res.text).toContain("tests/newbug.test.ts > introduced by this unit");
	// The new-failure header comes FIRST, ahead of the full reduced dump (which still includes the
	// pre-existing base failure too) — the fixup agent sees the signal before the noise.
	expect(res.text.indexOf("1 NEW failure")).toBeLessThan(res.text.indexOf("0 pass"));
});

test("NEW failure from untouched test file is excluded when the file passes in isolation", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		if (script === "bun test") {
			return {
				code: 1,
				stdout: "tests/restart-reattach.test.ts:\n0 pass\n1 fail\n(fail) flakes under load\n",
				stderr: "",
			};
		}
		return { code: 0, stdout: "tests/restart-reattach.test.ts:\n1 pass\nRan 1 tests across 1 files", stderr: "" };
	};
	const logs: string[] = [];
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: (file) => file === "tests/restart-reattach.test.ts",
		log: (message) => logs.push(message),
	});

	const res = await e.runCommand(goalGateNode, ctx());

	expect(res.outcome).toBe("succeeded");
	expect(calls).toEqual(["bun test", "bun test 'tests/restart-reattach.test.ts'"]);
	expect(res.text).toContain("1 flake excluded: tests/restart-reattach.test.ts");
	expect(res.text).toContain("0 introduced by this unit");
	expect(logs.join("\n")).toContain("environment-flake excluded: tests/restart-reattach.test.ts");
});

test("compound verify script isolates the bun-test segment instead of appending file to the last command", async () => {
	const compoundNode: WorkflowNode = {
		...goalGateNode,
		script: "bun test && ! grep -rn '^<<<<<<<' src/ webapp/src/",
	};
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		if (script === compoundNode.script) {
			return {
				code: 1,
				stdout: "tests/restart-reattach.test.ts:\n0 pass\n1 fail\n(fail) flakes under load\n",
				stderr: "",
			};
		}
		return { code: 0, stdout: "tests/restart-reattach.test.ts:\n1 pass\nRan 1 tests across 1 files", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: (file) => file === "tests/restart-reattach.test.ts",
	});

	const res = await e.runCommand(compoundNode, ctx());

	expect(res.outcome).toBe("succeeded");
	expect(calls).toEqual(["bun test && ! grep -rn '^<<<<<<<' src/ webapp/src/", "bun test 'tests/restart-reattach.test.ts' && ! grep -rn '^<<<<<<<' src/ webapp/src/"]);
});

test("NEW failure stays attributed when isolated retries keep failing", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		if (script === "bun test") return { code: 1, stdout: "tests/land-mode.test.ts:\n(fail) real regression\n", stderr: "" };
		return { code: 1, stdout: "tests/land-mode.test.ts:\n(fail) real regression\nRan 1 tests across 1 files\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: (file) => file === "tests/land-mode.test.ts",
	});

	const res = await e.runCommand(goalGateNode, ctx());

	expect(res.outcome).toBe("failed");
	expect(calls).toEqual(["bun test", "bun test 'tests/land-mode.test.ts'", "bun test 'tests/land-mode.test.ts'", "bun test 'tests/land-mode.test.ts'"]);
	expect(res.text).toContain("1 NEW failure");
	expect(res.text).toContain("real regression");
	expect(res.text).not.toContain("flake excluded");
});

test("NEW failure in a unit-touched test file is never excluded without isolation reruns", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		return { code: 1, stdout: "(fail) tests/agent-host-stderr-drain.test.ts > changed by unit\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["tests/agent-host-stderr-drain.test.ts"],
	});

	const res = await e.runCommand(goalGateNode, ctx());

	expect(res.outcome).toBe("failed");
	expect(calls).toEqual(["bun test"]);
	expect(res.text).toContain("1 NEW failure");
	expect(res.text).toContain("tests/agent-host-stderr-drain.test.ts > changed by unit");
	expect(res.text).not.toContain("flake excluded");
});

test("untouched file with no recorded flake history is still attributed", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		if (script === "bun test") return { code: 1, stdout: "tests/new-race.test.ts:\n(fail) solo-pass is still suspect\n", stderr: "" };
		return { code: 0, stdout: "tests/new-race.test.ts:\n1 pass\nRan 1 tests across 1 files\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: () => false,
	});
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(calls).toEqual(["bun test"]);
	expect(res.text).toContain("solo-pass is still suspect");
});

test("multi-file whole-output failure identity is not excludable", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		return script === "bun test"
			? { code: 1, stdout: "TypeError: whole output dump mentions tests/restart-reattach.test.ts\n", stderr: "" }
			: { code: 0, stdout: "tests/restart-reattach.test.ts:\n1 pass\nRan 1 tests across 1 files\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: () => true,
	});
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(calls).toEqual(["bun test"]);
	expect(res.text).not.toContain("flake excluded");
});

test("spoofed path in test title does not pick the file for exclusion", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		return script === "bun test"
			? { code: 1, stdout: "tests/source-race.test.ts:\n(fail) title names tests/restart-reattach.test.ts > fake\n", stderr: "" }
			: { code: 0, stdout: "tests/source-race.test.ts:\n1 pass\nRan 1 tests across 1 files\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["tests/source-race.test.ts"],
		hasRecordedFlakeForFile: (file) => file === "tests/restart-reattach.test.ts",
	});
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(calls).toEqual(["bun test"]);
	expect(res.text).not.toContain("flake excluded");
});

test("zero-tests-ran isolation does not exclude", async () => {
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		return script === "bun test"
			? { code: 1, stdout: "tests/restart-reattach.test.ts:\n(fail) filtered away\n", stderr: "" }
			: { code: 0, stdout: "Ran 0 tests across 0 files\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: () => true,
	});
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(calls.length).toBe(4);
	expect(res.text).not.toContain("flake excluded");
});

test("piped or quoted-and scripts fall back to bun test ./file", async () => {
	const node: WorkflowNode = { ...goalGateNode, script: "echo 'a && b' && bun test | cat" };
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		return script === node.script
			? { code: 1, stdout: "tests/restart-reattach.test.ts:\n(fail) flakes under load\n", stderr: "" }
			: { code: 0, stdout: "tests/restart-reattach.test.ts:\n1 pass\nRan 1 tests across 1 files\n", stderr: "" };
	};
	const e = exec({
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef: "abcdef0123456789" }),
		listChangedFilesSinceBase: async () => ["src/workflow/executor.ts"],
		hasRecordedFlakeForFile: () => true,
	});
	const res = await e.runCommand(node, ctx());
	expect(res.outcome).toBe("succeeded");
	expect(calls).toEqual(["echo 'a && b' && bun test | cat", "bun test './tests/restart-reattach.test.ts'"]);
});

test("dirty tree test edits are included in touched detection", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "verify-dirty-touched-"));
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "test@example.com");
	await git(repo, "config", "user.name", "Test");
	await fs.mkdir(path.join(repo, "tests"), { recursive: true });
	await fs.writeFile(path.join(repo, "tests/dirty.test.ts"), "base\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	const baseRef = "HEAD";
	await fs.writeFile(path.join(repo, "tests/dirty.test.ts"), "dirty\n");
	const calls: string[] = [];
	const execCommand = async (script: string) => {
		calls.push(script);
		return script === "bun test"
			? { code: 1, stdout: "tests/dirty.test.ts:\n(fail) dirty edit\n", stderr: "" }
			: { code: 0, stdout: "tests/dirty.test.ts:\n1 pass\nRan 1 tests across 1 files\n", stderr: "" };
	};
	const e = exec({
		cwd: repo,
		execCommand,
		resolveBaselineFailures: async () => ({ failures: [], unrunnable: null, baseRef }),
		hasRecordedFlakeForFile: () => true,
	});
	const res = await e.runCommand(goalGateNode, ctx());
	expect(res.outcome).toBe("failed");
	expect(calls).toEqual(["bun test"]);
	await fs.rm(repo, { recursive: true, force: true });
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
