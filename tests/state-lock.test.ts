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
	// pid 1 (init) is always alive; signal-0 from a non-root test yields EPERM → treated as live.
	writeFileSync(path.join(dir, "daemon.lock"), JSON.stringify({ pid: 1, host: os.hostname(), startedAt: 0 }));
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
