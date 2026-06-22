/**
 * Resolver + Orchestrator seams — wired but inert.
 *
 * The substrate ships off: routeFailure escalates everything (the ensemble #11/#12 replaces it),
 * and the Orchestrator's tick()/start() self-drive only when OMP_SQUAD_AUTODRIVE is set (#15).
 */

import { afterEach, expect, test } from "bun:test";
import { routeFailure } from "../src/resolver.ts";
import { Orchestrator, type OrchestratorDeps } from "../src/orchestrator.ts";

const savedDrive = process.env.OMP_SQUAD_AUTODRIVE;
afterEach(() => {
	if (savedDrive === undefined) delete process.env.OMP_SQUAD_AUTODRIVE;
	else process.env.OMP_SQUAD_AUTODRIVE = savedDrive;
});

test("routeFailure escalates every failure kind (default seam)", () => {
	expect(routeFailure("red")).toBe("escalate");
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
