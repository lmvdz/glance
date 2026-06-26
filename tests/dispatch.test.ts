/**
 * Dispatcher — deterministic tests (no Plane, no tokens, no clock). Every external
 * edge is injected, so we pin the selection + concurrency logic that decides which
 * open issues become routed agents.
 */

import { expect, test } from "bun:test";
import { Dispatcher, dispatchOrder, type DispatchDeps } from "../src/dispatch.ts";
import { noAutoDispatchName } from "../src/plane.ts";
import { occupyingAgents } from "../src/scheduler.ts";
import type { AgentDTO, AgentStatus, IssueRef } from "../src/types.ts";

const issue = (id: string, priority?: IssueRef["priority"]): IssueRef => ({ id, name: `issue ${id}`, priority });

const dto = (status: AgentStatus): AgentDTO => ({
	id: status, name: status, status, kind: "omp-operator",
	repo: "/r", worktree: "/w", approvalMode: "write", pending: [], lastActivity: 0, messageCount: 0,
});

function harness(over: Partial<DispatchDeps> = {}): { deps: DispatchDeps; spawned: string[] } {
	const spawned: string[] = [];
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async () => [issue("A"), issue("B"), issue("C")],
		spawn: async (_repo, iss) => {
			spawned.push(iss.id);
		},
		claimed: () => new Set(),
		activeCount: () => 0,
		log: () => {},
		maxActive: 10,
		...over,
	};
	return { deps, spawned };
}

test("dispatcher: spawns one routed agent per new open issue", async () => {
	const { deps, spawned } = harness();
	expect(await new Dispatcher(deps).tick()).toBe(3);
	expect(spawned.sort()).toEqual(["A", "B", "C"]);
});

test("dispatcher: never double-dispatches a claimed or already-dispatched issue", async () => {
	const { deps, spawned } = harness({ claimed: () => new Set(["B"]) });
	const d = new Dispatcher(deps);
	await d.tick();
	expect(spawned.sort()).toEqual(["A", "C"]); // B is already in the roster
	await d.tick(); // A,C already dispatched; B still claimed → nothing new
	expect(spawned.sort()).toEqual(["A", "C"]);
});

test("dispatcher: caps per-tick spawns at maxActive (no spawn storm)", async () => {
	const { deps, spawned } = harness({ maxActive: 2 });
	expect(await new Dispatcher(deps).tick()).toBe(2);
	expect(spawned.length).toBe(2);
});

test("dispatcher: counts already-busy agents against the budget", async () => {
	const { deps, spawned } = harness({ maxActive: 3, activeCount: () => 2 });
	await new Dispatcher(deps).tick();
	expect(spawned.length).toBe(1); // only 1 free slot
});

test("dispatcher: skips a repo whose Plane source is unconfigured (null)", async () => {
	const { deps, spawned } = harness({ listIssues: async () => null });
	expect(await new Dispatcher(deps).tick()).toBe(0);
	expect(spawned.length).toBe(0);
});

test("dispatcher: a single spawn failure doesn't abort the tick", async () => {
	const tried: string[] = [];
	const { deps } = harness({
		spawn: async (_r, i) => {
			tried.push(i.id);
			if (i.id === "A") throw new Error("boom");
		},
	});
	expect(await new Dispatcher(deps).tick()).toBe(2); // A failed; B, C spawned
	expect(tried.sort()).toEqual(["A", "B", "C"]);
});

test("dispatcher: spawns nothing when already at the global WIP cap", async () => {
	const { deps, spawned } = harness({ maxActive: 10, maxWip: 3, liveCount: () => 3 });
	expect(await new Dispatcher(deps).tick()).toBe(0); // global cap bounds total live agents, not just dispatched ones
	expect(spawned.length).toBe(0);
});

test("dispatcher: bounds total spawns by the global WIP cap as live agents accrue", async () => {
	let live = 4;
	const got: string[] = [];
	const { deps } = harness({
		maxActive: 10, // per-tick budget is wide; the global cap is the binding constraint
		maxWip: 5,
		liveCount: () => live,
		spawn: async (_repo, iss) => {
			got.push(iss.id);
			live++; // each spawn becomes a live agent, like manager.create adding to the roster
		},
	});
	expect(await new Dispatcher(deps).tick()).toBe(1); // only 1 slot before live hits the cap of 5
	expect(got.length).toBe(1);
});

test("dispatcher: defers an issue while a blocker is still open, then dispatches once it clears", async () => {
	let issues: IssueRef[] = [{ id: "A", name: "a" }, { id: "B", name: "b", blockedBy: ["A"] }];
	const spawned: string[] = [];
	const deps: DispatchDeps = {
		repos: () => ["/r"],
		listIssues: async () => issues,
		spawn: async (_r, i) => { spawned.push(i.id); },
		claimed: () => new Set(),
		activeCount: () => 0,
		log: () => {},
		maxActive: 10,
	};
	const d = new Dispatcher(deps);
	await d.tick();
	expect(spawned).toEqual(["A"]); // B deferred — its blocker A is still open
	issues = [{ id: "B", name: "b", blockedBy: ["A"] }]; // A done → leaves the open list
	await d.tick();
	expect(spawned.sort()).toEqual(["A", "B"]); // B now unblocked and dispatched
});

test("dispatcher: a blocker not in the open list (done / other project) does not defer", async () => {
	const { deps, spawned } = harness({ listIssues: async () => [{ id: "C", name: "c", blockedBy: ["Z"] }] });
	await new Dispatcher(deps).tick();
	expect(spawned).toEqual(["C"]); // Z absent from the open list ⇒ not blocking
});

test("dispatcher: skips a human-review / no-auto-land issue (visible in UI, never auto-dispatched)", async () => {
	const { deps, spawned } = harness({
		listIssues: async () => [issue("A"), { id: "B", name: "SECURITY-CRITICAL — human review", noAutoDispatch: true }],
	});
	expect(await new Dispatcher(deps).tick()).toBe(1);
	expect(spawned).toEqual(["A"]); // only the normal issue; the flagged one is never spawned
});

test("noAutoDispatchName flags human-review / do-not-auto-land names, not plain ones", () => {
	expect(noAutoDispatchName("do NOT auto-land")).toBe(true);
	expect(noAutoDispatchName("SECURITY-CRITICAL — human review")).toBe(true);
	expect(noAutoDispatchName("human-review needed")).toBe(true);
	expect(noAutoDispatchName("Fix the dispatcher backlog bug")).toBe(false);
});

test("dispatcher: an all-idle roster does not pin the WIP cap (occupying count, not live)", async () => {
	const roster = [dto("idle"), dto("idle"), dto("idle")];
	const { deps, spawned } = harness({ maxActive: 10, maxWip: 3, liveCount: () => occupyingAgents(roster) });
	expect(await new Dispatcher(deps).tick()).toBe(3); // 0 occupying → cap not pinned; all 3 dispatch
	expect(spawned.sort()).toEqual(["A", "B", "C"]);
});

test("dispatcher: WIP cap counts only occupying agents (idle/stopped don't pin it)", async () => {
	const roster = [dto("working"), dto("idle"), dto("stopped"), dto("input")]; // 2 occupying (working+input)
	let live = occupyingAgents(roster); // 2 — idle/stopped excluded, so the cap starts with headroom
	const got: string[] = [];
	const { deps } = harness({
		maxActive: 10,
		maxWip: 3,
		liveCount: () => live,
		spawn: async (_repo, iss) => {
			got.push(iss.id);
			live++; // each spawn occupies a new slot, like manager.create adding to the roster
		},
	});
	expect(await new Dispatcher(deps).tick()).toBe(1); // 2 occupying < cap 3 → exactly 1 slot before the cap binds
	expect(got.length).toBe(1);
});

test("dispatcher: dispatches higher-priority Plane issues first without bypassing caps", async () => {
	const { deps, spawned } = harness({
		maxActive: 2,
		listIssues: async () => [issue("low", "low"), issue("urgent", "urgent"), issue("high", "high")],
	});
	expect(await new Dispatcher(deps).tick()).toBe(2);
	expect(spawned).toEqual(["urgent", "high"]);
});

test("dispatchOrder ranks known priorities before plain issues", () => {
	expect([issue("B"), issue("A", "urgent"), issue("C", "high")].sort(dispatchOrder).map((i) => i.id)).toEqual(["A", "C", "B"]);
});
