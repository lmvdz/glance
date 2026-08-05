/**
 * state-lock — single-writer guard over a squad state dir: stale reclaim,
 * live-owner refusal, and clean release.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireStateLock, StateLockError, loadFlock, probeFlockExclusive, reclaimFencePath, type Flock } from "../src/state-lock.ts";

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

test("N reclaimers racing a SEEDED stale lock (plus garbage at the fence path) end with exactly one owner (#345)", async () => {
	// This is the gauntlet's exact interleaving: backfill is SIGKILLed leaving a
	// stale lock; daemons D1..Dn start together, all read it and determine its
	// pid is dead. Under the original bug, one unlinks-and-recreates, and a peer's
	// ALREADY-AUTHORIZED unlink then deletes that fresh lock and creates its own —
	// both believe they own the state dir. The prior "concurrent acquirers" test
	// starts from an empty dir and never seeds a stale lock racers must all
	// reclaim — this closes that gap.
	//
	// Also seeds garbage content at the ACTUAL fence path (`<file>.fence`), as if
	// left behind by some earlier interrupted run. The fix must not care what's
	// in it or how it got there — flock locks live with the kernel, not in the
	// file's bytes, so a pre-existing file is just an inert target to open, never
	// something that gets "reclaimed" or "stolen" on a timer.
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	// Pid 2^31-1 is effectively never a running process — a seeded stale lock.
	writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 }));
	writeFileSync(reclaimFencePath(file), "leftover debris from an earlier run — must be irrelevant to the fix");
	const child = path.join(import.meta.dir, "fixtures", "lock-race-stale-reclaimer-child.ts");
	// No artificial delay: the fix's real kernel lock makes the outcome
	// deterministic regardless of scheduling. More racers just gives adversarial
	// scheduling more surface to exercise.
	const N = 8;
	const procs = Array.from({ length: N }, () => Bun.spawn(["bun", child, dir], { stdout: "ignore", stderr: "inherit" }));
	const codes = await Promise.all(procs.map((p) => p.exited));
	expect(codes).not.toContain(2); // no unexpected error — every racer must cleanly win or lose
	const owners = codes.filter((c) => c === 0).length;
	const losers = codes.filter((c) => c === 1).length;
	expect(owners).toBe(1); // exactly one racer may believe it owns the dir
	expect(losers).toBe(N - 1); // everyone else gets a clean StateLockError
});

test("real round-1 debris — a DIRECTORY at the old <file>.reclaim path — never causes EISDIR (#345 round 3, #4)", async () => {
	// A SIGKILLed round-1 (mkdir-mutex) daemon left `<file>.reclaim` behind as a
	// DIRECTORY (that design used mkdirSync on this exact path). The round-2 fix
	// alone would `openSync(reclaimFile, "a+")` on it and throw EISDIR — this
	// test seeds the real shape (a directory, not a file) that the round-2
	// self-verification missed. The round-3 fix moves the fence to a new
	// filename (`.fence`) so this path is never opened, and opportunistically
	// cleans the leftover directory up.
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 }));
	mkdirSync(`${file}.reclaim`); // real round-1 debris shape: a directory, not a file
	const lock = await acquireStateLock(dir);
	cleanups.push(() => lock.release());
	const rec = JSON.parse(await fs.readFile(lock.file, "utf8"));
	expect(rec.pid).toBe(process.pid);
	// Opportunistic cleanup: the stray directory should be gone afterward.
	await expect(fs.stat(`${file}.reclaim`)).rejects.toThrow();
});

test("probeFlockExclusive: true for the real flock on a local filesystem, false for a no-op stub (#345 round 3, #3/#5)", async () => {
	// Direct, deterministic unit test of the self-test itself — must fail the
	// suite if this logic regresses (e.g. someone breaks the LOCK_NB flag),
	// independent of whether the slower multi-process race test happens to
	// notice. Grok's finding: the suite must ASSERT exclusion, not just rely on
	// the race test's absence of failure.
	const dir = await tmpdir();
	const testPath = path.join(dir, "probe-target");
	const flock = loadFlock();
	expect(flock).not.toBeNull();
	if (!flock) return; // unreachable after the assert above; narrows the type

	// Real flock on this (local, ext4/tmpfs-class) filesystem must be exclusive.
	expect(probeFlockExclusive(flock, testPath)).toBe(true);

	// A deliberately no-op stub — as if flock silently didn't exclude anything,
	// the exact failure mode of a client-local NFS mount — must be caught.
	const noopStub: Flock = { lock: () => 0, errno: () => 0 }; // "always succeeds"
	expect(probeFlockExclusive(noopStub, path.join(dir, "probe-target-2"))).toBe(false);
});

test("a fence held by a wedged/stopped reclaimer cannot wedge boot forever (#345 round 3, #1)", async () => {
	// Simulates the exact round-3 failure mode: a process holding the reclaim
	// fence gets SIGSTOPped or wedged in a stuck syscall — it never releases,
	// but it's also not dead (a live, real process). A blocking `flock(LOCK_EX)`
	// would block every future acquirer in the libc call itself, forever, since
	// the deadline is never even consulted. The fix (bounded LOCK_EX|LOCK_NB
	// retry) must give up and throw StateLockError well before the holder's
	// hold time elapses — proving boot is bounded, not just "usually fast."
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 })); // seeded stale
	const readyFile = path.join(dir, "holder-ready");
	const holderChild = path.join(import.meta.dir, "fixtures", "lock-fence-holder-child.ts");
	const holder = Bun.spawn(["bun", holderChild, dir, readyFile], { stdout: "ignore", stderr: "inherit" });
	cleanups.push(async () => {
		holder.kill();
		await holder.exited.catch(() => {});
	});
	// Wait for the holder to actually acquire the fence before racing it.
	const readyDeadline = Date.now() + 3_000;
	while (Date.now() < readyDeadline) {
		const isReady = await fs
			.stat(readyFile)
			.then(() => true)
			.catch(() => false);
		if (isReady) break;
		await Bun.sleep(10);
	}

	const handoffMs = 500;
	const t0 = Date.now();
	await expect(acquireStateLock(dir, { handoffMs })).rejects.toBeInstanceOf(StateLockError);
	const elapsedMs = Date.now() - t0;
	// The holder holds for 4s; if we ever blocked in flock(LOCK_EX) itself, this
	// would take ~4s (or hang, for a truly wedged process). Bounded well under that.
	expect(elapsedMs).toBeLessThan(2_000);
});
