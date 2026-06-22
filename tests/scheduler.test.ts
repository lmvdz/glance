/**
 * Scheduler — admission/concurrency carved out of squad-manager.
 *
 * Covers the two moved pieces: the WIP-cap count (`liveAgents` + `canAdmit` honouring
 * OMP_SQUAD_MAX_WIP) and the FIFO admission queue (enqueue/dequeue order). The cap boundary
 * mirrors create()'s gate so the move is behaviour-preserving.
 */

import { afterEach, expect, test } from "bun:test";
import { liveAgents, Scheduler } from "../src/scheduler.ts";
import type { AgentDTO, AgentStatus, CreateAgentOptions } from "../src/types.ts";

const savedWip = process.env.OMP_SQUAD_MAX_WIP;
afterEach(() => {
	if (savedWip === undefined) delete process.env.OMP_SQUAD_MAX_WIP;
	else process.env.OMP_SQUAD_MAX_WIP = savedWip;
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

test("cap reads OMP_SQUAD_MAX_WIP per call, defaulting to 6", () => {
	const s = new Scheduler();
	delete process.env.OMP_SQUAD_MAX_WIP;
	expect(s.cap()).toBe(6);
	process.env.OMP_SQUAD_MAX_WIP = "2";
	expect(s.cap()).toBe(2); // live env change takes effect without a fresh Scheduler
});

test("canAdmit gates exactly at the ceiling (count >= cap is full)", () => {
	const s = new Scheduler();
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
