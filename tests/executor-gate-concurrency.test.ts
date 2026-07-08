/**
 * Executor-level proof for the gate-concurrency fix (spawn-heavy-flake-under-load incident):
 * `SingleAgentExecutor.runCommand` gates every command node through a shared semaphore, so two
 * UNITS' command nodes (verify/codefix/reproduce — the full-suite spawn-heavy gate commands) never
 * run at the same time, and the WAIT never costs a node an extra visit-cap attempt.
 *
 * Each test injects its OWN `GateSemaphore` instance (never the real process-wide singleton) so
 * these tests can't contend with each other or with any other suite running concurrently.
 */

import { expect, test } from "bun:test";
import { GateSemaphore } from "../src/gate-semaphore.ts";
import { parseWorkflow } from "../src/workflow/dot.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { EngineCheckpoint, RunContext, WorkflowNode } from "../src/workflow/types.ts";

function exec(cwd: string, gateSemaphore: GateSemaphore, execCommand: (script: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>) {
	return new SingleAgentExecutor({
		cwd,
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand,
		gateSemaphore,
	});
}

const node: WorkflowNode = { id: "verify", kind: "command", label: "Verify", script: "bun run check && bun run test", attrs: {} };
const ctx = (): RunContext => ({ goal: "g", vars: {} });

test("two units' verify commands never overlap when gated through the same semaphore (concurrency 1)", async () => {
	const gate = new GateSemaphore(1);
	const intervals: Array<{ id: string; start: number; end: number }> = [];

	const slowExec = (id: string) => async (_script: string, _cwd: string) => {
		const start = Date.now();
		await new Promise((r) => setTimeout(r, 40));
		intervals.push({ id, start, end: Date.now() });
		return { code: 0, stdout: "ok", stderr: "" };
	};

	const unitA = exec(".", gate, slowExec("A"));
	const unitB = exec(".", gate, slowExec("B"));

	const [ra, rb] = await Promise.all([unitA.runCommand(node, ctx()), unitB.runCommand(node, ctx())]);
	expect(ra.outcome).toBe("succeeded");
	expect(rb.outcome).toBe("succeeded");

	expect(intervals).toHaveLength(2);
	const [first, second] = intervals.sort((a, b) => a.start - b.start);
	// The second unit's command must not have STARTED before the first one ENDED — true serialization,
	// not "they happened to both finish eventually."
	expect(second!.start).toBeGreaterThanOrEqual(first!.end);
});

test("a slow gate ahead does not block a DIFFERENT node's own visit accounting — each engine.run() records exactly one visit for its verify node despite a long queue wait", async () => {
	const gate = new GateSemaphore(1);
	const wf = parseWorkflow(`digraph G {
		start  [shape=Mdiamond]
		exit   [shape=Msquare]
		verify [shape=parallelogram, label="Verify", script="true", goal_gate=true, max_visits=1]
		start  -> verify
		verify -> exit
	}`);

	const checkpointsA: EngineCheckpoint[] = [];
	const checkpointsB: EngineCheckpoint[] = [];

	// Unit A's gate command is slow (holds the semaphore for a while); unit B's is instant but must
	// wait behind A. If waiting ever caused an extra visit to be recorded, B's final visit count for
	// "verify" would be >1 (or the run would prematurely escalate/fail on a maxVisits=1 node).
	const execA = exec(".", gate, async () => {
		await new Promise((r) => setTimeout(r, 120));
		return { code: 0, stdout: "", stderr: "" };
	});
	const execB = exec(".", gate, async () => ({ code: 0, stdout: "", stderr: "" }));

	const runA = new WorkflowEngine(wf, execA).run("goal A", { checkpoint: (c) => checkpointsA.push(c) });
	// Start B slightly after A so A is guaranteed to hold the gate first and B is the one queued.
	await new Promise((r) => setTimeout(r, 10));
	const runB = new WorkflowEngine(wf, execB).run("goal B", { checkpoint: (c) => checkpointsB.push(c) });

	const [resA, resB] = await Promise.all([runA, runB]);

	expect(resA.outcome).toBe("succeeded");
	expect(resB.outcome).toBe("succeeded"); // B was NOT starved into its maxVisits=1 cap by queueing

	const lastA = checkpointsA[checkpointsA.length - 1]!;
	const lastB = checkpointsB[checkpointsB.length - 1]!;
	expect(lastA.visits.verify).toBe(1); // exactly one attempt recorded — the wait was invisible to the engine
	expect(lastB.visits.verify).toBe(1);
});

test("release on throw: a command that rejects still frees the gate for the next queued unit (no deadlock)", async () => {
	const gate = new GateSemaphore(1);
	const failing = exec(".", gate, async () => {
		throw new Error("spawn exploded");
	});
	const following = exec(".", gate, async () => ({ code: 0, stdout: "ok", stderr: "" }));

	// First call's execCommand throws — runCommand itself doesn't catch it (matches the pre-existing
	// contract: a throwing execCommand propagates), but the semaphore slot must still be released.
	const firstCall = failing.runCommand(node, ctx()).catch((err: unknown) => err);
	const secondCall = new Promise<void>((resolve) => setTimeout(resolve, 15)).then(() => following.runCommand(node, ctx()));

	const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
	expect(firstResult).toBeInstanceOf(Error);
	expect(secondResult.outcome).toBe("succeeded"); // proves the slot was released, not leaked
});

test("onGateWait fires once when a command waits past the threshold, with the node id and queue depth, and is skipped when the slot is immediately free", async () => {
	const gate = new GateSemaphore(1);
	const waits: Array<{ nodeId: string; aheadInQueue: number }> = [];

	const holder = exec(".", gate, async () => {
		await new Promise((r) => setTimeout(r, 60));
		return { code: 0, stdout: "", stderr: "" };
	});
	const waiter = new SingleAgentExecutor({
		cwd: ".",
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
		gateSemaphore: gate,
		gateWarnAfterMs: 20, // fast threshold so the test doesn't wait a real 30s
		onGateWait: (n, _elapsedMs, aheadInQueue) => waits.push({ nodeId: n.id, aheadInQueue }),
	});

	const holderRun = holder.runCommand(node, ctx());
	await new Promise((r) => setTimeout(r, 5));
	const waiterRun = waiter.runCommand(node, ctx());

	await Promise.all([holderRun, waiterRun]);
	expect(waits).toHaveLength(1);
	expect(waits[0]!.nodeId).toBe("verify");
	expect(waits[0]!.aheadInQueue).toBe(1);
});
