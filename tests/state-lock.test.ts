/**
 * state-lock — single-writer guard over a squad state dir: stale reclaim,
 * live-owner refusal, and clean release.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireStateLock, StateLockError } from "../src/state-lock.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function tmpdir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lock-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

test("acquire writes a lock file and release removes it", async () => {
	const dir = await tmpdir();
	const lock = await acquireStateLock(dir);
	const stat = await fs.stat(lock.file);
	expect(stat.isFile()).toBe(true);
	lock.release();
	await expect(fs.stat(lock.file)).rejects.toThrow();
	lock.release(); // idempotent — no throw
});

test("a live owner blocks a second acquire", async () => {
	const dir = await tmpdir();
	// The parent process is live and signalable in both host and rootless docker runs.
	writeFileSync(path.join(dir, "daemon.lock"), JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: 0 }));
	await expect(acquireStateLock(dir, { handoffMs: 150 })).rejects.toBeInstanceOf(StateLockError);
});
test("a stale lock (dead pid) is reclaimed", async () => {
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	// Pid 2^31-1 is effectively never a running process.
	writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 }));
	const lock = await acquireStateLock(dir);
	cleanups.push(() => lock.release());
	const rec = JSON.parse(await fs.readFile(lock.file, "utf8"));
	expect(rec.pid).toBe(process.pid);
});

test("a corrupt lock file is treated as stale and reclaimed", async () => {
	const dir = await tmpdir();
	writeFileSync(path.join(dir, "daemon.lock"), "not json {{{");
	const lock = await acquireStateLock(dir);
	cleanups.push(() => lock.release());
	const rec = JSON.parse(await fs.readFile(lock.file, "utf8"));
	expect(rec.pid).toBe(process.pid);
});

test("a live pid with a mismatched recorded start time (pid reuse) is reclaimed", async () => {
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	// pid 1 (init) always exists, so signal-0 alone would call this "live" forever.
	// A recorded `proc` start time that can't match init's proves the pid was recycled.
	writeFileSync(file, JSON.stringify({ pid: 1, host: os.hostname(), startedAt: 0, proc: -1 }));
	// Reuse detection needs /proc; on a host without it the lock stays live (prior behaviour).
	let hasProc = true;
	try {
		await fs.stat("/proc/1/stat");
	} catch {
		hasProc = false;
	}
	if (!hasProc) return;
	const lock = await acquireStateLock(dir, { handoffMs: 150 });
	cleanups.push(() => lock.release());
	const rec = JSON.parse(await fs.readFile(lock.file, "utf8"));
	expect(rec.pid).toBe(process.pid);
});

test("concurrent acquirers never both own the lock (no empty-file TOCTOU window)", async () => {
	// Race many separate processes on one state dir. Each child acquires, then
	// reads the lock file back and exits 3 if it holds a lock file containing
	// someone else's pid — the exact corruption the openSync(wx)+writeSync window
	// allowed (a racer unlinks a just-created empty lock and writes its own).
	// link()-based acquire publishes the record atomically, so this can't happen.
	const dir = await tmpdir();
	const child = path.join(import.meta.dir, "fixtures", "lock-race-child.ts");
	const procs = Array.from({ length: 12 }, () =>
		Bun.spawn(["bun", child, dir], { stdout: "ignore", stderr: "inherit" }),
	);
	const codes = await Promise.all(procs.map((p) => p.exited));
	expect(codes).not.toContain(3); // 0 = won or cleanly refused; 3 = double-owned a corrupted lock
});

test("two reclaimers racing a SEEDED stale lock end with exactly one owner (#345)", async () => {
	// This is the gauntlet's exact interleaving: backfill is SIGKILLed leaving a
	// stale lock; daemons D1 and D2 start together, both read it and determine
	// its pid is dead. D1 unlinks it, loops, creates D1's live lock. Under the
	// bug, D2 then executes its ALREADY-AUTHORIZED unlinkSync — deleting D1's
	// new lock — and creates its own. Both D1 and D2 now believe they own the
	// state dir. The prior "concurrent acquirers" test starts from an empty dir
	// and never seeds a stale lock two racers must both reclaim — this closes
	// that gap.
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	// Pid 2^31-1 is effectively never a running process — a seeded stale lock.
	writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 }));
	const child = path.join(import.meta.dir, "fixtures", "lock-race-stale-reclaimer-child.ts");
	// Widen the decide-then-unlink window well past two racers' actual fs work
	// (a handful of synchronous syscalls, sub-millisecond) so the interleaving
	// is forced deterministically rather than hoping for scheduler luck.
	const delayMs = 200;
	const procs = [Bun.spawn(["bun", child, dir, String(delayMs)], { stdout: "ignore", stderr: "inherit" }), Bun.spawn(["bun", child, dir, String(delayMs)], { stdout: "ignore", stderr: "inherit" })];
	const codes = await Promise.all(procs.map((p) => p.exited));
	const owners = codes.filter((c) => c === 0).length;
	expect(owners).toBe(1); // exactly one of the two racers may believe it owns the dir
});
