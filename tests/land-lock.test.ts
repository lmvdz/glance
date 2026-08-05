/**
 * withRepoLandLock — per-repo serialization of operations that touch the shared main checkout
 * (OMPSQ-168). The Observer's acceptance gate reads the same tree a land mutates; running them
 * concurrently lets the gate `(fail)` against a half-merged main and file a false `regression:` bug.
 * The lock must make all work on one repo strictly non-overlapping, while different repos run free.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

// ── T5 gauntlet round 3 (glance#356, finding #4): the lock key must be CANONICALIZED ────────────────
// Before this fix, `withRepoLandLock` keyed its `Map` on the raw string a caller passed — `/repo` and
// `/repo/.` (or a trailing slash, or a symlink hop) are the SAME checkout on disk but were TWO different
// `Map` keys, so two callers naming the same repo two different (but equivalent) ways would run fully
// concurrently — bypassing the mutual exclusion this lock exists to guarantee entirely.

test("ROUND 3 (finding #4): '/repo' and '/repo/.' — textually different but filesystem-identical — are now serialized as ONE lock, not two", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "land-lock-canon-"));
	try {
		const t = tracker();
		const results = await Promise.all([
			withRepoLandLock(dir, t.run("plain")),
			// Plain string concatenation, DELIBERATELY not `path.join` (which normalizes "." away itself,
			// masking the very bug this test exists to catch before `withRepoLandLock` ever sees it) — the
			// raw, un-normalized string a caller might genuinely construct or receive.
			withRepoLandLock(`${dir}/.`, t.run("dot-suffixed")),
		]);
		// Before finding #4's fix, these were TWO different `Map` keys — `maxConcurrent` would have been 2
		// (the bug this test catches: two lands on the SAME checkout interleaving `git merge` and
		// corrupting the index, exactly the OMPSQ-168 failure mode `withRepoLandLock` exists to prevent).
		expect(t.maxConcurrent).toBe(1);
		expect(results).toEqual(["plain", "dot-suffixed"]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

test("ROUND 3 (finding #4): a trailing slash on an otherwise-identical repo path is ALSO recognized as the same lock", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "land-lock-canon-slash-"));
	try {
		const t = tracker();
		await Promise.all([
			withRepoLandLock(dir, t.run("no-slash")),
			withRepoLandLock(`${dir}/`, t.run("trailing-slash")),
		]);
		expect(t.maxConcurrent).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

test("ROUND 3 (finding #4): a non-existent repo path still gets a stable, non-throwing lock key (realpath fallback)", async () => {
	const t = tracker();
	// `/definitely/does/not/exist-<random>` never exists on disk — `fs.realpathSync` throws for it, so the
	// canonicalization must fall back to a normalized (but non-throwing) key rather than crashing the lock.
	const repo = `/definitely/does/not/exist-${Math.random().toString(36).slice(2)}`;
	const results = await Promise.all([
		withRepoLandLock(repo, t.run("a")),
		withRepoLandLock(repo, t.run("b")),
	]);
	expect(t.maxConcurrent).toBe(1);
	expect(results).toEqual(["a", "b"]);
});
