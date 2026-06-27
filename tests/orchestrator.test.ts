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

test("holdForConfirm: green plain agent is staged for one-tap Land, not auto-landed; staged work is not re-verified", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	const landed: string[] = [];
	const ready: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle")], // plain (no featureId)
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		verifyAgent: async (id) => {
			verified.push(id);
			return true;
		},
		landAgentWork: async (id) => {
			landed.push(id);
			return true;
		},
		holdForConfirm: true,
		notifyReady: (id) => ready.push(id),
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(verified).toEqual(["ag"]); // gate ran
	expect(ready).toEqual(["ag"]); // staged for a one-tap Land
	expect(landed).toEqual([]); // NOT merged
	expect(logs.some((l) => l.includes("ready to land agent:ag"))).toBe(true);

	await orch.tick(); // staged ⇒ no re-verify, no land
	expect(verified).toEqual(["ag"]);
	expect(ready).toEqual(["ag"]);
	expect(landed).toEqual([]);
});

test("landAgentWork returning 'staged' stages the work — notify, no re-attempt, never parked (OMPSQ-175)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const landCalls: string[] = [];
	const ready: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle")], // plain (no featureId)
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => true,
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		verifyAgent: async () => true,
		landAgentWork: async (id) => {
			landCalls.push(id);
			return "staged"; // auto-resolve confirm hold: resolved on the branch, awaiting one-tap Land
		},
		holdForConfirm: false, // auto-merge mode — the staged signal comes from the land path, not verify
		notifyReady: (id) => ready.push(id),
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(landCalls).toEqual(["ag"]); // land attempted once
	expect(ready).toEqual(["ag"]); // staged for a one-tap Land
	expect(logs.some((l) => l.includes("ready to land agent:ag") && l.includes("auto-resolved"))).toBe(true);
	expect(logs.some((l) => l.includes("parked"))).toBe(false); // never parked
	expect(logs.some((l) => l.includes("land blocked"))).toBe(false); // not treated as a blocked land

	// Staged ⇒ the loop holds: no re-attempt across ticks, and never parks.
	await orch.tick();
	await orch.tick();
	await orch.tick();
	expect(landCalls).toEqual(["ag"]); // still exactly one land attempt
	expect(ready).toEqual(["ag"]);
	expect(logs.some((l) => l.includes("parked"))).toBe(false);
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

test("onCatastrophe fires once per summon (Queue + push surface) — OMPSQ-135", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const summons: Array<{ id: string; detail: string }> = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle", "F4")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => true, // green, but the tripwire bypasses verify
		land: async () => {
			throw new Error("land must not run when a tripwire fired");
		},
		isCatastrophic: () => true,
		onCatastrophe: (id, detail) => summons.push({ id, detail }),
	});

	await orch.tick(); // tripwire → catastrophe → onCatastrophe
	await orch.tick(); // halted ⇒ no second summon

	expect(summons.length).toBe(1); // surfaced exactly once, not re-summoned each tick
	expect(summons[0].id).toBe("ag");
	expect(summons[0].detail).toContain("tripwire fired");
});

test("queued spawns are admitted only while under the WIP cap, draining as slots free (#13)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	process.env.OMP_SQUAD_MAX_WIP = "3";
	delete process.env.OMP_SQUAD_RESOURCE_GATE; // hermetic: assert count-cap admission, not ambient host-pressure backoff
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

test("blocked land is retried under a cap, then parked — never an infinite merge/reset loop", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	let verifyCalls = 0;
	let landCalls = 0;
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("blk", "idle")], // plain agent; gate green but land always blocked
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		verifyAgent: async () => {
			verifyCalls++;
			return true;
		},
		landAgentWork: async () => {
			landCalls++;
			return false; // diverged / conflict / dirty main — never merges
		},
		log: (m) => logs.push(m),
	});

	await orch.tick(); // blocks=1 → will retry (1/3)
	await orch.tick(); // blocks=2 → will retry (2/3)
	await orch.tick(); // blocks=3 → parked
	expect(verifyCalls).toBe(3);
	expect(landCalls).toBe(3);
	expect(logs.some((l) => l.includes("will retry (1/3)"))).toBe(true);
	expect(logs.some((l) => l.includes("parked") && l.includes("blk"))).toBe(true);

	await orch.tick(); // parked ⇒ halted ⇒ no further verify/land
	expect(verifyCalls).toBe(3);
	expect(landCalls).toBe(3);
});

test("a retryable land (dirty main checkout) is retried every tick — never block-counted, never parked/halted", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	let landCalls = 0;
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [agent("dirty", "idle")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		verifyAgent: async () => true,
		landAgentWork: async () => {
			landCalls++;
			return "retryable"; // main checkout was dirty — environmental, not a branch defect
		},
		log: (m) => logs.push(m),
	});

	for (let i = 0; i < 5; i++) await orch.tick();
	expect(landCalls).toBe(5); // retried EVERY tick — never parked/halted past a cap
	expect(logs.some((l) => l.includes("land deferred") && l.includes("dirty"))).toBe(true);
	expect(logs.some((l) => l.includes("land blocked"))).toBe(false); // not counted as a blocked land
	expect(logs.some((l) => l.includes("parked"))).toBe(false); // never parked
});

// ── OMPSQ-164: a re-adopted idle agent's complete work is auto-landed after a relaunch ──
// adoptOrphanedAgents re-creates such an agent (committed work, clean worktree, never re-run), so the
// event-driven auto-land (workflow_done) never fires. The orchestrator must land it DIRECTLY, using
// the land path's own merge→gate→rollback as the gate — NOT an isolated worktree pre-verify, which
// gives a false negative on a stale-but-mergeable branch.
const adopted = (id: string, featureId?: string): AgentDTO => ({ ...agent(id, "idle", featureId), adopted: true });

test("re-adopted idle agent is landed directly within a tick, skipping the isolated worktree pre-verify (OMPSQ-164)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const verified: string[] = [];
	const landed: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [adopted("ag")], // plain, re-adopted with committed work
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		// Stale branch: the ISOLATED worktree verify is RED (lacks newer main code) — must be skipped.
		verifyAgent: async (id) => {
			verified.push(id);
			return false;
		},
		landAgentWork: async (id) => {
			landed.push(id); // the MERGED gate (merge→verify→rollback-on-red) passes
			return true;
		},
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(verified).toEqual([]); // isolated pre-verify skipped — the false-negative this fixes
	expect(landed).toEqual(["ag"]); // landed via the merged gate
	expect(logs.some((l) => l.includes("landed agent:ag") && l.includes("re-adopted"))).toBe(true);

	await orch.tick(); // already landed ⇒ no churn
	expect(verified).toEqual([]);
	expect(landed).toEqual(["ag"]);
});

test("re-adopted idle agent whose MERGED gate fails is parked under the land cap, not retried forever (OMPSQ-164)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	let landCalls = 0;
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [adopted("blk")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		verifyAgent: async () => {
			throw new Error("isolated pre-verify must not run for a re-adopted agent");
		},
		landAgentWork: async () => {
			landCalls++;
			return false; // the merged gate genuinely fails (conflict / red after merge)
		},
		log: (m) => logs.push(m),
	});

	await orch.tick(); // blocks=1 → retry (1/3)
	await orch.tick(); // blocks=2 → retry (2/3)
	await orch.tick(); // blocks=3 → parked
	expect(landCalls).toBe(3);
	expect(logs.some((l) => l.includes("parked") && l.includes("blk"))).toBe(true);

	await orch.tick(); // parked ⇒ halted ⇒ no further land attempt
	expect(landCalls).toBe(3);
});

test("holdForConfirm: a re-adopted idle agent is staged for a one-tap Land, not blind-merged (OMPSQ-164)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const ready: string[] = [];
	const landed: string[] = [];
	const logs: string[] = [];
	const orch = new Orchestrator({
		listAgents: () => [adopted("ag")],
		spawn: async () => {
			throw new Error("no spawn in this test");
		},
		verify: async () => {
			throw new Error("feature verify must not run for a plain agent");
		},
		land: async () => {
			throw new Error("feature land must not run for a plain agent");
		},
		agentHasWork: async () => true,
		verifyAgent: async () => {
			throw new Error("isolated pre-verify must not run for a re-adopted agent");
		},
		landAgentWork: async () => {
			landed.push("ag");
			return true;
		},
		holdForConfirm: true,
		notifyReady: (id) => ready.push(id),
		log: (m) => logs.push(m),
	});

	await orch.tick();
	expect(ready).toEqual(["ag"]); // staged for the operator's one-tap Land
	expect(landed).toEqual([]); // NOT blind-merged
	expect(logs.some((l) => l.includes("ready to land agent:ag") && l.includes("re-adopted"))).toBe(true);

	await orch.tick(); // staged ⇒ no re-attempt
	expect(landed).toEqual([]);
});

// ── OMPSQ-139: halted/landed/staged are persisted by branch so a restart doesn't re-drive ──
// agents. A fresh Orchestrator sharing the same on-disk ledger must skip a previously-parked or
// already-landed branch even though create() mints a new agent id on re-adoption.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openOrchestratorState } from "../src/orchestrator-state.ts";

test("halted/landed decisions persist across a restart, keyed by branch (OMPSQ-139)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const dir = mkdtempSync(path.join(tmpdir(), "orch-state-"));
	try {
		// ── Boot 1: a feature agent on branch feat/x exhausts its repair budget → CATASTROPHE (halted). ──
		const halt = { ...agent("old-id", "idle", "F1"), branch: "feat/x" };
		const verified1: string[] = [];
		const logs1: string[] = [];
		const orch1 = new Orchestrator({
			listAgents: () => [halt],
			spawn: async () => { throw new Error("no spawn"); },
			verify: async (id) => { verified1.push(id); return false; }, // red gate
			land: async () => { throw new Error("must not land a red gate"); },
			route: () => "escalate", // straight to catastrophe
			log: (m) => logs1.push(m),
			persist: openOrchestratorState(dir),
		});
		await orch1.tick();
		expect(verified1).toEqual(["F1"]);
		expect(logs1.some((l) => l.startsWith("CATASTROPHE:"))).toBe(true);

		// ── Boot 2: a NEW Orchestrator (fresh in-memory sets) over the same ledger. The agent is
		//    re-adopted with a NEW id but the SAME branch — it must stay parked: no re-verify. ──
		const readopted = { ...agent("new-id", "idle", "F1"), branch: "feat/x" };
		const verified2: string[] = [];
		const orch2 = new Orchestrator({
			listAgents: () => [readopted],
			spawn: async () => { throw new Error("no spawn"); },
			verify: async (id) => { verified2.push(id); return true; },
			land: async () => { throw new Error("a halted branch must not be re-landed"); },
			persist: openOrchestratorState(dir),
		});
		await orch2.tick();
		expect(verified2).toEqual([]); // halted branch skipped before verify — no re-summon, no re-spend

		// ── A separate branch that landed in boot 2 must skip re-verify in boot 3. ──
		const landAgent = { ...agent("lander", "idle", "F2"), branch: "feat/y" };
		const orch3 = new Orchestrator({
			listAgents: () => [landAgent],
			spawn: async () => { throw new Error("no spawn"); },
			verify: async () => true,
			land: async () => true,
			persist: openOrchestratorState(dir),
		});
		await orch3.tick(); // verifies + lands feat/y, persisting it as landed

		const verified4: string[] = [];
		const orch4 = new Orchestrator({
			listAgents: () => [{ ...agent("lander-2", "idle", "F2"), branch: "feat/y" }],
			spawn: async () => { throw new Error("no spawn"); },
			verify: async (id) => { verified4.push(id); return true; },
			land: async () => { throw new Error("an already-landed branch must not be re-landed"); },
			persist: openOrchestratorState(dir),
		});
		await orch4.tick();
		expect(verified4).toEqual([]); // landed branch skipped before verify
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── #15: re-entrancy guard ─────────────────────────────────────────────────────
// A tick that takes longer than the interval must not be overlapped by the next one.
// The guard must release in the `finally` block even when the tick throws.

test("re-entrancy guard: a second tick that arrives while the first is in flight is skipped (#15)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	let verifyCalls = 0;
	let resolveBlock!: () => void;
	const blockFirst = new Promise<void>((res) => { resolveBlock = res; });

	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle", "F5")],
		spawn: async () => { throw new Error("no spawn"); },
		verify: async () => {
			verifyCalls++;
			// First verify call blocks until we release it — simulates a slow tick.
			if (verifyCalls === 1) await blockFirst;
			return true;
		},
		land: async () => true,
		log: () => {},
	});

	// Start first tick (long-running) and second tick concurrently.
	const t1 = orch.tick();
	// The second tick must be a no-op because ticking=true.
	const t2 = orch.tick();
	await t2; // resolves immediately (skipped)
	expect(verifyCalls).toBe(1); // second tick was a no-op — guard fired

	resolveBlock(); // let the first tick complete
	await t1;
	expect(verifyCalls).toBe(1); // still only one verify call from tick 1

	// After tick 1 completes, the guard is released and a new tick may proceed.
	await orch.tick();
	// ag was already landed by tick1 — so no new verify call.
	expect(verifyCalls).toBe(1);
});

test("re-entrancy guard releases after a throwing tick — subsequent ticks proceed normally (#15)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	let calls = 0;
	const orch = new Orchestrator({
		listAgents: () => [agent("ag", "idle", "F6")],
		spawn: async () => { throw new Error("no spawn"); },
		verify: async () => {
			calls++;
			if (calls === 1) throw new Error("simulated transient failure");
			return true;
		},
		land: async () => true,
		log: () => {},
	});

	// First tick throws — the guard must release in finally so the next tick runs.
	// (The outer interval handler in start() catches and logs this — here we catch it directly.)
	await orch.tick().catch(() => {});
	expect(calls).toBe(1);

	// Guard must be released; second tick must proceed.
	await orch.tick();
	expect(calls).toBe(2); // second tick verified the agent
});

// ── #19: ledger purge ─────────────────────────────────────────────────────────
// Ledger entries for branches that no longer exist in the roster must be purged so
// the on-disk state file doesn't grow unbounded.

test("purgeStale: ledger entries for gone branches are purged; live branches are untouched (#19)", async () => {
	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const dir = mkdtempSync(path.join(tmpdir(), "orch-purge-"));
	try {
		const persist = openOrchestratorState(dir);
		// Pre-populate the ledger with two branches.
		persist.markLanded("feat/gone"); // this branch will not appear in the roster
		persist.markHalted("feat/live"); // this one will stay

		expect(persist.isLanded("feat/gone")).toBe(true);
		expect(persist.isHalted("feat/live")).toBe(true);

		// Roster contains only feat/live.
		const rosterAgent = { ...agent("a", "idle", "F7"), branch: "feat/live" };
		const orch = new Orchestrator({
			listAgents: () => [rosterAgent],
			spawn: async () => { throw new Error("no spawn"); },
			verify: async () => true,
			land: async () => true,
			persist,
			log: () => {},
		});

		await orch.tick();

		// feat/live is live — must NOT be purged.
		expect(persist.isHalted("feat/live")).toBe(true);
		// feat/gone is absent from the roster — must be purged.
		expect(persist.isLanded("feat/gone")).toBe(false);

		// Purge must be durable: a new persistence instance over the same file must also show the purge.
		const persist2 = openOrchestratorState(dir);
		expect(persist2.isLanded("feat/gone")).toBe(false);
		expect(persist2.isHalted("feat/live")).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
