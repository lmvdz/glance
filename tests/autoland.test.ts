/**
 * Auto-land is the loop-closer that removes the operator from landing, so its
 * decision must be exact: land a SUCCESSFUL run only when the mode is on, never a
 * failed one, and never silently swallow a conflict. Pure policy, no git/omp.
 */
import { expect, test } from "bun:test";
import { autoLandOnSuccess } from "../src/autoland.ts";
import type { LandResult } from "../src/land.ts";

const landed = (detail: string): LandResult => ({ ok: true, committed: true, merged: true, message: "m", detail });
const conflict: LandResult = { ok: false, committed: false, merged: false, message: "m", detail: "merge failed: conflict in src/x.ts" };

function harness(land: (id: string) => Promise<LandResult>) {
	const logs: string[] = [];
	return { logs, deps: { land, log: (m: string) => logs.push(m) } };
}

test("lands a successful run when the mode is on", async () => {
	let id: string | undefined;
	const { logs, deps } = harness(async (i) => {
		id = i;
		return landed("merged (fast-forward)");
	});
	const res = await autoLandOnSuccess(true, "succeeded", { id: "a1", name: "alpha" }, deps);
	expect(id).toBe("a1");
	expect(res?.ok).toBe(true);
	expect(logs.some((l) => l.includes("auto-landed alpha"))).toBe(true);
});

test("does nothing when the mode is off", async () => {
	let called = false;
	const { deps } = harness(async () => {
		called = true;
		return landed("x");
	});
	const res = await autoLandOnSuccess(false, "succeeded", { id: "a1", name: "alpha" }, deps);
	expect(called).toBe(false);
	expect(res).toBeNull();
});

test("never lands a failed run", async () => {
	let called = false;
	const { deps } = harness(async () => {
		called = true;
		return landed("x");
	});
	const res = await autoLandOnSuccess(true, "failed", { id: "a1", name: "alpha" }, deps);
	expect(called).toBe(false);
	expect(res).toBeNull();
});

test("surfaces a conflict instead of dropping it", async () => {
	const { logs, deps } = harness(async () => conflict);
	const res = await autoLandOnSuccess(true, "succeeded", { id: "a1", name: "alpha" }, deps);
	expect(res?.ok).toBe(false);
	expect(logs.some((l) => l.includes("auto-land blocked") && l.includes("conflict resolution"))).toBe(true);
});
