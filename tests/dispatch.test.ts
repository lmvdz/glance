/**
 * Dispatcher — deterministic tests (no Plane, no tokens, no clock). Every external
 * edge is injected, so we pin the selection + concurrency logic that decides which
 * open issues become routed agents.
 */

import { expect, test } from "bun:test";
import { Dispatcher, type DispatchDeps } from "../src/dispatch.ts";
import type { IssueRef } from "../src/types.ts";

const issue = (id: string): IssueRef => ({ id, name: `issue ${id}` });

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
