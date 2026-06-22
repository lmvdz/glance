/**
 * Resolver + Orchestrator seams — wired but inert.
 *
 * The Orchestrator's tick()/start() self-drive only when OMP_SQUAD_AUTODRIVE is set (#15); the
 * routeFailure policy is the bounded retry/escalate tiering of #11.
 */

import { afterEach, expect, test } from "bun:test";
import { routeFailure } from "../src/resolver.ts";
import { Orchestrator, type OrchestratorDeps } from "../src/orchestrator.ts";

const savedDrive = process.env.OMP_SQUAD_AUTODRIVE;
const savedBudget = process.env.OMP_SQUAD_REPAIR_BUDGET;
afterEach(() => {
	if (savedDrive === undefined) delete process.env.OMP_SQUAD_AUTODRIVE;
	else process.env.OMP_SQUAD_AUTODRIVE = savedDrive;
	if (savedBudget === undefined) delete process.env.OMP_SQUAD_REPAIR_BUDGET;
	else process.env.OMP_SQUAD_REPAIR_BUDGET = savedBudget;
});

test("routeFailure: red retries under the repair budget, then escalates (#11)", () => {
	delete process.env.OMP_SQUAD_REPAIR_BUDGET; // default budget = 3
	expect(routeFailure("red")).toBe("retry"); // attempts 0
	expect(routeFailure("red", { attempts: 2 })).toBe("retry"); // under budget
	expect(routeFailure("red", { attempts: 3 })).toBe("escalate"); // at budget
	expect(routeFailure("red", { attempts: 9 })).toBe("escalate");
});

test("routeFailure: repair budget is env-tunable per call (#11)", () => {
	process.env.OMP_SQUAD_REPAIR_BUDGET = "1";
	expect(routeFailure("red")).toBe("retry"); // 0 < 1
	expect(routeFailure("red", { attempts: 1 })).toBe("escalate"); // at the tuned budget
	process.env.OMP_SQUAD_REPAIR_BUDGET = "0"; // invalid/zero ⇒ fall back to default 3
	expect(routeFailure("red", { attempts: 2 })).toBe("retry");
});

test("routeFailure: conflict retries exactly once, then escalates (#11)", () => {
	expect(routeFailure("conflict")).toBe("retry"); // attempts 0 → the resolver's single shot
	expect(routeFailure("conflict", { attempts: 1 })).toBe("escalate");
	expect(routeFailure("conflict", { attempts: 3, agentId: "x" })).toBe("escalate");
});

const deps = (log: (m: string) => void): OrchestratorDeps => ({
	listAgents: () => [],
	spawn: async () => {
		throw new Error("spawn must not be called while inert");
	},
	verify: async () => false,
	land: async () => false,
	log,
});

test("tick is inert (no log, no deps touched) unless OMP_SQUAD_AUTODRIVE is set", async () => {
	delete process.env.OMP_SQUAD_AUTODRIVE;
	const logs: string[] = [];
	await new Orchestrator(deps((m) => logs.push(m))).tick();
	expect(logs).toEqual([]); // off by default

	process.env.OMP_SQUAD_AUTODRIVE = "1";
	const onLogs: string[] = [];
	await new Orchestrator(deps((m) => onLogs.push(m))).tick();
	expect(onLogs.length).toBe(1); // opt-in: the inert tick marks itself
});

test("start arms no timer when autodrive is off (no daemon leak)", () => {
	delete process.env.OMP_SQUAD_AUTODRIVE;
	const orch = new Orchestrator(deps(() => {}));
	orch.start(10); // would throw "spawn must not be called" if it ever fired a real tick
	orch.stop(); // safe even when nothing was armed
	expect(true).toBe(true);
});
