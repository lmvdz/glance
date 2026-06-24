/**
 * withRepoLandLock — per-repo serialization of operations that touch the shared main checkout
 * (OMPSQ-168). The Observer's acceptance gate reads the same tree a land mutates; running them
 * concurrently lets the gate `(fail)` against a half-merged main and file a false `regression:` bug.
 * The lock must make all work on one repo strictly non-overlapping, while different repos run free.
 */

import { expect, test } from "bun:test";
import { withRepoLandLock } from "../src/land.ts";

/** A task that records its overlap window and yields the event loop a few times mid-flight. */
function tracker() {
	let active = 0;
	let maxConcurrent = 0;
	const order: string[] = [];
	const run = (id: string, ticks = 3) => async () => {
		order.push(`${id}:start`);
		active++;
		maxConcurrent = Math.max(maxConcurrent, active);
		for (let i = 0; i < ticks; i++) await Promise.resolve();
		active--;
		order.push(`${id}:end`);
		return id;
	};
	return { run, get maxConcurrent() { return maxConcurrent; }, order };
}

test("same repo: queued operations never overlap and run in submission order (OMPSQ-168)", async () => {
	const t = tracker();
	const repo = "/repo-a";
	// A land and a gate-style op queued back-to-back on the same checkout.
	const results = await Promise.all([
		withRepoLandLock(repo, t.run("land")),
		withRepoLandLock(repo, t.run("gate")),
	]);
	expect(t.maxConcurrent).toBe(1); // strict mutual exclusion — the bug this fixes
	expect(t.order).toEqual(["land:start", "land:end", "gate:start", "gate:end"]);
	expect(results).toEqual(["land", "gate"]);
});

test("different repos run concurrently — the lock is per-repo, not global", async () => {
	const t = tracker();
	await Promise.all([
		withRepoLandLock("/repo-a", t.run("a")),
		withRepoLandLock("/repo-b", t.run("b")),
	]);
	expect(t.maxConcurrent).toBe(2); // independent checkouts are not serialized
});

test("a throwing operation does not wedge the queue for the next op on the same repo", async () => {
	const repo = "/repo-c";
	await expect(withRepoLandLock(repo, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
	// The next op must still run (the chain swallows the prior rejection internally).
	const ok = await withRepoLandLock(repo, async () => "ok");
	expect(ok).toBe("ok");
});
