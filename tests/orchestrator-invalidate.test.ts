/**
 * `Orchestrator.invalidate` — a human instruction makes prior auto-loop decisions stale.
 *
 * The steering lane (G3c) made a prompt to a FINISHED unit actually reach its agent. That surfaced a
 * defect that would have shipped silently: the orchestrator's `staged` / `landed` sets are in-memory and
 * keyed by `workId` (`agent:<id>`, or the featureId), and `halted` by agent id. None of those keys change
 * when a steered agent edits files, and the `landed.has` / `staged.has` guards run BEFORE `agentHasWork`.
 * So once a unit had been verified-and-staged, everything a later steer produced was skipped forever —
 * verified never, landed never. (The durable HEAD-derived `stateKey` records go stale on their own; the
 * in-memory sets cannot.) Found by cross-lineage review (gpt-5.6-sol) of the steering fix.
 *
 * Fake deps, mirroring tests/orchestrator.test.ts.
 */

import { afterEach, expect, test } from "bun:test";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AgentDTO, AgentStatus } from "../src/types.ts";

const savedDrive = process.env.OMP_SQUAD_AUTODRIVE;
afterEach(() => {
	if (savedDrive === undefined) delete process.env.OMP_SQUAD_AUTODRIVE;
	else process.env.OMP_SQUAD_AUTODRIVE = savedDrive;
});

const agent = (id: string, status: AgentStatus, featureId?: string): AgentDTO => ({
	id,
	name: id,
	status,
	kind: "omp-operator",
	repo: "/r",
	worktree: "/w",
	approvalMode: "write",
	pending: [],
	lastActivity: 0,
	messageCount: 0,
	featureId,
});

/** Confirm-mode: verify green ⇒ the work is STAGED for a one-tap Land, and the workId is remembered. */
function stagingOrchestrator(verified: string[]): Orchestrator {
	return new Orchestrator({
		listAgents: () => [agent("ag", "idle", "F1")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async (id) => {
			verified.push(id);
			return true;
		},
		land: async () => "staged",
		holdForConfirm: true,
		notifyReady: () => {},
		log: () => {},
	});
}

test("a staged workId is skipped on later ticks — the guard that strands steered work", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	const orch = stagingOrchestrator(verified);

	await orch.tick();
	expect(verified).toEqual(["F1"]); // verified once, then staged

	await orch.tick();
	expect(verified).toEqual(["F1"]); // …and never looked at again. This is the defect's mechanism.
});

test("invalidate() clears the staged decision so a steered unit is verified again", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	const orch = stagingOrchestrator(verified);

	await orch.tick();
	expect(verified).toEqual(["F1"]);

	orch.invalidate("ag", "F1"); // ← what SquadManager now calls when a prompt is delivered

	await orch.tick();
	expect(verified).toEqual(["F1", "F1"]); // the steer's work gets a fresh verify (before the fix: one)
});

test("invalidate() un-halts a parked unit — that is what 'step in' means", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	let fail = true;
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => false,
		land: async () => false,
		verifyAgent: async (id) => {
			verified.push(id);
			return !fail;
		},
		landAgentWork: async () => true,
		agentHasWork: async () => true,
		routeFailure: () => "escalate",
		log: () => {},
	});

	// Tick until the failing unit stops being driven — i.e. the route escalated it and it is halted.
	let prev = -1;
	for (let i = 0; i < 8 && verified.length !== prev; i++) {
		prev = verified.length;
		await orch.tick();
	}
	const afterHalt = verified.length;
	await orch.tick();
	expect(verified.length).toBe(afterHalt); // halted: the auto-loop no longer touches it

	fail = false;
	orch.invalidate("ag"); // a human steps in and steers it

	await orch.tick();
	expect(verified.length).toBeGreaterThan(afterHalt); // it resumes
});

test("invalidate() on an unknown id is a harmless no-op", () => {
	const orch = new Orchestrator({
		listAgents: () => [],
		spawn: async () => {
			throw new Error("unused");
		},
		verify: async () => true,
		land: async () => true,
	});
	expect(() => orch.invalidate("nope", "nope-feature")).not.toThrow();
});
