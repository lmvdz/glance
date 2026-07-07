/**
 * Legibility-only classification in SingleAgentExecutor.runCommand (factory-spawn-provisioning
 * incident): a verify-gate command node dying because ITS OWN environment was never provisioned
 * (no node_modules — exit 127 / "command not found") reads, in the escalate/CATASTROPHE detail an
 * operator sees, identically to the code under test actually being broken. This prefixes the text
 * fed forward with a distinct marker WITHOUT changing `outcome` (still "failed" on any non-zero
 * exit) — the engine's visit-cap math (workflow/engine.ts) never inspects `text`, so escalate's
 * cap and every other cap fire exactly as before.
 */

import { expect, test } from "bun:test";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

function exec(execCommand: (script: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>): SingleAgentExecutor {
	return new SingleAgentExecutor({
		cwd: "/tmp",
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand,
	});
}

const node: WorkflowNode = { id: "verify", kind: "command", label: "Verify", script: "bun run check && bun run test", attrs: {} };
const ctx: RunContext = { goal: "g", vars: {} };

test("exit 127 (command not found) is flagged as environment-not-provisioned, outcome stays failed", async () => {
	const e = exec(async () => ({ code: 127, stdout: "", stderr: "bash: bun: command not found" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed"); // unchanged — no behavior/cap impact
	expect(res.text).toContain("environment not provisioned");
	expect(res.text).toContain("command not found");
});

test("stderr mentioning MODULE_NOT_FOUND is flagged even on a non-127 exit code", async () => {
	const e = exec(async () => ({ code: 1, stdout: "", stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'typescript'" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed");
	expect(res.text).toContain("environment not provisioned");
});

test("a real test failure (non-zero exit, no missing-deps signature) is NOT flagged", async () => {
	const e = exec(async () => ({ code: 1, stdout: "1 failing\n  1) some assertion\n     expected true to be false", stderr: "" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed");
	expect(res.text).not.toContain("environment not provisioned");
	expect(res.text).toContain("assertion");
});

test("a passing gate (exit 0) is never flagged, even if its output happens to mention 'command not found'", async () => {
	const e = exec(async () => ({ code: 0, stdout: "note: no 'command not found' issues detected", stderr: "" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("succeeded");
	expect(res.text).not.toContain("environment not provisioned");
});
