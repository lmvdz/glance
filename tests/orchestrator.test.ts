/**
 * Orchestrator — self-healing control loop (#15 auto-land, #14 catastrophe, #13 drain, #11/#12 route).
 *
 * Every effect runs through fake deps with OMP_SQUAD_AUTODRIVE on: a green idle agent lands; a red one
 * retries under the route's budget then escalates to a logged CATASTROPHE; a tripwire summons a human
 * before verify; parked spawns admit only under the WIP cap; and the whole tick is inert when the flag
 * is unset (the gate short-circuits before any dep, including listAgents).
 */

import { afterEach, expect, test } from "bun:test";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AgentDTO, AgentStatus, CreateAgentOptions } from "../src/types.ts";

const savedDrive = process.env.OMP_SQUAD_AUTODRIVE;
const savedWip = process.env.OMP_SQUAD_MAX_WIP;
afterEach(() => {
	if (savedDrive === undefined) delete process.env.OMP_SQUAD_AUTODRIVE;
	else process.env.OMP_SQUAD_AUTODRIVE = savedDrive;
	if (savedWip === undefined) delete process.env.OMP_SQUAD_MAX_WIP;
	else process.env.OMP_SQUAD_MAX_WIP = savedWip;
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

test("idle agent that verifies green is landed once; non-idle peers and re-ticks are skipped (#15)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	const landed: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("busy", "working", "F9"), agent("ag", "idle", "F1")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async (id) => {
			verified.push(id);
			return true;
		},
		land: async (id) => {
			landed.push(id);
			return true;
		},
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(verified).toEqual(["F1"]); // working agent skipped — only idle with work is driven
	expect(landed).toEqual(["F1"]);
	expect(logs.some((l) => l.includes("landed F1"))).toBe(true);

	await orch.tick(); // already landed ⇒ no churn (no re-verify, no re-land)
	expect(verified).toEqual(["F1"]);
	expect(landed).toEqual(["F1"]);
});

test("featureless idle agent with work is verified + landed via the agent path (typed-prompt auto-land)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	const landed: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("nowork", "idle"), agent("ag", "idle")], // both plain (no featureId)
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async (id) => id === "ag", // only "ag" has unlanded work
		verifyAgent: async (id) => {
			verified.push(id);
			return true;
		},
		landAgentWork: async (id) => {
			landed.push(id);
			return true;
		},
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(verified).toEqual(["ag"]); // "nowork" gated out before the costly acceptance run
	expect(landed).toEqual(["ag"]);
	expect(logs.some((l) => l.includes("landed agent:ag"))).toBe(true);

	await orch.tick(); // already landed ⇒ no churn
	expect(verified).toEqual(["ag"]);
	expect(landed).toEqual(["ag"]);
});

test("featureless agent that fails its gate is parked, not escalated to a human", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	let verifyCalls = 0;
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("red", "idle")], // plain agent whose gate is red
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => false,
		land: async () => false,
		agentHasWork: async () => true,
		verifyAgent: async () => {
			verifyCalls++;
			return false;
		},
		landAgentWork: async () => {
			throw new Error("a red agent must never be landed");
		},
		route: () => "escalate", // the escalate verdict becomes a park (not a catastrophe) for ad-hoc work
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(verifyCalls).toBe(1);
	expect(logs.some((l) => l.includes("parked red"))).toBe(true);
	expect(logs.some((l) => l.startsWith("CATASTROPHE:"))).toBe(false);

	await orch.tick(); // parked ⇒ halted ⇒ never re-verified
	expect(verifyCalls).toBe(1);
});

test("red gate retries under budget, then escalates to CATASTROPHE at budget (#11/#12 → #14)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const budget = 2; // route retries while attempts < 2, escalates at 2
	const seenAttempts: number[] = [];
	const verifyCalls: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle", "F2")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async (id) => {
			verifyCalls.push(id);
			return false;
		},
		land: async () => {
			throw new Error("land must not run on a red gate");
		},
		route: (kind, ctx) => {
			expect(kind).toBe("red");
			const n = ctx?.attempts ?? 0;
			seenAttempts.push(n);
			return n < budget ? "retry" : "escalate";
		},
		log: (m) => logs.push(m),
	});

	await orch.tick(); // attempts 0 → retry
	await orch.tick(); // attempts 1 → retry
	await orch.tick(); // attempts 2 → escalate → CATASTROPHE + halt
	await orch.tick(); // halted ⇒ item is no longer touched

	expect(seenAttempts).toEqual([0, 1, 2]); // budget walked up, no route call after escalation
	expect(verifyCalls).toEqual(["F2", "F2", "F2"]); // halted ⇒ not re-verified
	const catas = logs.filter((l) => l.startsWith("CATASTROPHE:"));
	expect(catas.length).toBe(1);
	expect(catas[0]).toContain("repair budget exhausted");
});

test("isCatastrophic tripwire summons a human before verify/land (#14)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verifyCalls: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle", "F3")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async (id) => {
			verifyCalls.push(id);
			return true;
		},
		land: async () => {
			throw new Error("land must not run when a tripwire fired");
		},
		isCatastrophic: () => true,
		log: (m) => logs.push(m),
	});

	await orch.tick();
	await orch.tick(); // halted thereafter

	expect(verifyCalls).toEqual([]); // tripwire bypassed verify/land entirely
	expect(logs.filter((l) => l.startsWith("CATASTROPHE:")).length).toBe(1);
});

test("queued spawns are admitted only while under the WIP cap, draining as slots free (#13)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	process.env.OMP_SQUAD_MAX_WIP = "3";
	const roster: AgentDTO[] = [agent("live-1", "working"), agent("live-2", "working")]; // 2 live, cap 3 ⇒ room for 1
	const spawned: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => roster,
		spawn: async (opts) => {
			const a = agent(opts.name ?? `s-${spawned.length}`, "working");
			roster.push(a);
			spawned.push(a.id);
			return a;
		},
		verify: async () => {
			throw new Error("no verify in this test");
		},
		land: async () => {
			throw new Error("no land in this test");
		},
		log: () => {},
	});
	orch.scheduler.enqueue({ repo: "/r", name: "q1" } satisfies CreateAgentOptions);
	orch.scheduler.enqueue({ repo: "/r", name: "q2" } satisfies CreateAgentOptions);

	await orch.tick();
	expect(spawned).toEqual(["q1"]); // one fit (2 live → 3 = cap), then admission stops
	expect(orch.scheduler.queued).toBe(1); // q2 stays parked

	roster.length = 0;
	roster.push(agent("live-1", "working")); // free two slots
	await orch.tick();
	expect(spawned).toEqual(["q1", "q2"]); // parked request drains under the freed cap
	expect(orch.scheduler.queued).toBe(0);
});

test("tick is fully inert when OMP_SQUAD_AUTODRIVE is unset (gate precedes every dep)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "0"; // now opt-OUT: self-drive is on by default, so disable it explicitly
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => {
			throw new Error("listAgents must not run while gated off");
		},
		spawn: async () => {
			throw new Error("no spawn while gated off");
		},
		verify: async () => {
			throw new Error("no verify while gated off");
		},
		land: async () => {
			throw new Error("no land while gated off");
		},
		log: (m) => logs.push(m),
	});
	orch.scheduler.enqueue({ repo: "/r", name: "q1" } satisfies CreateAgentOptions);

	await orch.tick(); // returns immediately — no dep, not even listAgents, runs

	expect(logs).toEqual([]);
	expect(orch.scheduler.queued).toBe(1); // admission queue untouched
});
