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
