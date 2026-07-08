/**
 * Legibility-only classification in SingleAgentExecutor.runCommand (factory-spawn-provisioning
 * incident): a verify-gate command node dying because ITS OWN environment was never provisioned
 * (no node_modules — exit 127 / "command not found") reads, in the escalate/CATASTROPHE detail an
 * operator sees, identically to the code under test actually being broken. This prefixes the text
 * fed forward with a distinct marker WITHOUT changing `outcome` (still "failed" on any non-zero
 * exit) — the engine's visit-cap math (workflow/engine.ts) never inspects `text`, so escalate's
 * cap and every other cap fire exactly as before.
 *
 * Cross-lineage review MEDIUM 4: the tag is anchored on the ENVIRONMENT FACT — the worktree's
 * node_modules must actually be ABSENT — not on output text alone. A real app bug whose message
 * merely looks like a missing-module error, in a tree whose deps ARE installed, must never get
 * the tag (it would steer fixup toward "reinstall deps" instead of the actual defect).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await rm(d, { recursive: true, force: true }).catch(() => {});
});

async function bareTree(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "glance-unprov-bare-"));
	tmps.push(dir);
	return dir; // NO node_modules — the unprovisioned environment
}

async function provisionedTree(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "glance-unprov-warm-"));
	tmps.push(dir);
	await mkdir(path.join(dir, "node_modules"));
	return dir; // node_modules present — deps ARE installed
}

function exec(cwd: string, execCommand: (script: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>): SingleAgentExecutor {
	return new SingleAgentExecutor({
		cwd,
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand,
	});
}

const node: WorkflowNode = { id: "verify", kind: "command", label: "Verify", script: "bun run check && bun run test", attrs: {} };
const ctx: RunContext = { goal: "g", vars: {} };

test("exit 127 with node_modules ABSENT is flagged as environment-not-provisioned, outcome stays failed", async () => {
	const e = exec(await bareTree(), async () => ({ code: 127, stdout: "", stderr: "bash: bun: command not found" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed"); // unchanged — no behavior/cap impact
	expect(res.text).toContain("environment not provisioned");
	expect(res.text).toContain("command not found");
});

test("MODULE_NOT_FOUND with node_modules ABSENT is flagged even on a non-127 exit code", async () => {
	const e = exec(await bareTree(), async () => ({ code: 1, stdout: "", stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'typescript'" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed");
	expect(res.text).toContain("environment not provisioned");
});

test("a missing-module-SHAPED failure with node_modules PRESENT is NOT flagged (env fact wins over output text)", async () => {
	// A real app bug — a bad relative import — produces "Cannot find module './nope.ts'" with deps
	// fully installed. Tagging it would steer fixup toward "reinstall deps" instead of the defect.
	const e = exec(await provisionedTree(), async () => ({ code: 1, stdout: "", stderr: "error: Cannot find module './nope.ts' from src/index.ts" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed");
	expect(res.text).not.toContain("environment not provisioned");
});

test("even exit 127 with node_modules PRESENT is NOT flagged — the env fact is the anchor", async () => {
	// e.g. a script invoking a genuinely nonexistent tool: deps are fine, the script is wrong.
	const e = exec(await provisionedTree(), async () => ({ code: 127, stdout: "", stderr: "bash: no-such-tool: command not found" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed");
	expect(res.text).not.toContain("environment not provisioned");
});

test("a real test failure (non-zero exit, no missing-deps signature) is NOT flagged even in a bare tree", async () => {
	const e = exec(await bareTree(), async () => ({ code: 1, stdout: "1 failing\n  1) some assertion\n     expected true to be false", stderr: "" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("failed");
	expect(res.text).not.toContain("environment not provisioned");
	expect(res.text).toContain("assertion");
});

test("a passing gate (exit 0) is never flagged, even if its output happens to mention 'command not found'", async () => {
	const e = exec(await bareTree(), async () => ({ code: 0, stdout: "note: no 'command not found' issues detected", stderr: "" }));
	const res = await e.runCommand(node, ctx);
	expect(res.outcome).toBe("succeeded");
	expect(res.text).not.toContain("environment not provisioned");
});
