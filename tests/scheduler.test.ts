/**
 * Scheduler — admission/concurrency carved out of squad-manager.
 *
 * Covers the two moved pieces: the WIP-cap count (`liveAgents` + `canAdmit` honouring
 * OMP_SQUAD_MAX_WIP) and the FIFO admission queue (enqueue/dequeue order). The cap boundary
 * mirrors create()'s gate so the move is behaviour-preserving.
 */

import { afterEach, expect, test } from "bun:test";
import { defaultWipCap, liveAgents, Scheduler } from "../src/scheduler.ts";
import type { AgentDTO, AgentStatus, CreateAgentOptions } from "../src/types.ts";

const savedWip = process.env.OMP_SQUAD_MAX_WIP;
const savedGate = process.env.OMP_SQUAD_RESOURCE_GATE;
afterEach(() => {
	if (savedWip === undefined) delete process.env.OMP_SQUAD_MAX_WIP;
	else process.env.OMP_SQUAD_MAX_WIP = savedWip;
	if (savedGate === undefined) delete process.env.OMP_SQUAD_RESOURCE_GATE;
	else process.env.OMP_SQUAD_RESOURCE_GATE = savedGate;
});

const dto = (status: AgentStatus): AgentDTO => ({
	id: status,
	name: status,
	status,
	kind: "omp-operator",
	repo: "/r",
	worktree: "/w",
	approvalMode: "write",
	pending: [],
	lastActivity: 0,
	messageCount: 0,
});

test("liveAgents counts non-terminal agents only (stopped/error free their slot)", () => {
	const roster = [dto("working"), dto("idle"), dto("starting"), dto("input"), dto("stopped"), dto("error")];
	expect(liveAgents(roster)).toBe(4);
	expect(liveAgents([])).toBe(0);
});

test("cap reads OMP_SQUAD_MAX_WIP per call, defaulting to the safe host-derived cap", () => {
	const s = new Scheduler(() => false);
	delete process.env.OMP_SQUAD_MAX_WIP;
	expect(s.cap()).toBe(defaultWipCap()); // safe default (~half the host CPUs), not a fixed 6
	expect(defaultWipCap()).toBeGreaterThanOrEqual(2);
	process.env.OMP_SQUAD_MAX_WIP = "2";
	expect(s.cap()).toBe(2); // explicit env still wins
});

test("canAdmit gates exactly at the ceiling (count >= cap is full)", () => {
	const s = new Scheduler(() => false); // no host pressure → isolate the count boundary
	process.env.OMP_SQUAD_MAX_WIP = "2";
	expect(s.canAdmit(1)).toBe(true); // headroom
	expect(s.canAdmit(2)).toBe(false); // at the cap → blocked, matching create()'s throw boundary
	expect(s.canAdmit(3)).toBe(false);
});

test("admission queue is FIFO and reports its depth", () => {
	const s = new Scheduler();
	const a: CreateAgentOptions = { repo: "/r", name: "a" };
	const b: CreateAgentOptions = { repo: "/r", name: "b" };
	expect(s.dequeue()).toBeUndefined(); // empty
	expect(s.queued).toBe(0);
	s.enqueue(a);
	s.enqueue(b);
	expect(s.queued).toBe(2);
	expect(s.dequeue()).toBe(a); // oldest first
	expect(s.dequeue()).toBe(b);
	expect(s.dequeue()).toBeUndefined();
	expect(s.queued).toBe(0);
});

test("canAdmit blocks under host pressure even with count headroom", () => {
	process.env.OMP_SQUAD_MAX_WIP = "6";
	const s = new Scheduler(() => true); // host pressured
	expect(s.pressured()).toBe(true);
	expect(s.canAdmit(0)).toBe(false); // room on the count cap, but pressure blocks
});

test("canAdmit needs both count headroom and no pressure", () => {
	process.env.OMP_SQUAD_MAX_WIP = "2";
	expect(new Scheduler(() => false).canAdmit(1)).toBe(true); // headroom + calm
	expect(new Scheduler(() => true).canAdmit(1)).toBe(false); // headroom but pressured
	expect(new Scheduler(() => false).canAdmit(2)).toBe(false); // calm but at the cap
});

test("default probe gates host-pressure behind OMP_SQUAD_RESOURCE_GATE (off ⇒ never pressured)", () => {
	delete process.env.OMP_SQUAD_RESOURCE_GATE;
	expect(new Scheduler().pressured()).toBe(false); // gate off → admission ignores host load
});
