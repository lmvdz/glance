/**
 * state-lock — single-writer guard over a squad state dir: stale reclaim,
 * live-owner refusal, and clean release.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireStateLock,
	probeDaemonLock,
	StateLockError,
	loadFlock,
	probeFlockExclusive,
	reclaimFencePath,
	acquireFenceOrThrow,
	recheckLiveBeforeUnsupported,
	ensureFlockExclusive,
	type Flock,
} from "../src/state-lock.ts";

// EINTR is 4 on every POSIX platform this targets (Linux, Darwin/BSD) — same
// stability assumption this file already makes for e.g. pid 2147483647 as a
// "never a real process" sentinel.
const EINTR = 4;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function tmpdir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lock-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

/** Poll for a fixture's readiness marker (a file it writes once it holds
 * whatever it's simulating), bounded so a broken fixture fails fast instead
 * of hanging the test. */
async function waitForReadyFile(readyFile: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const isReady = await fs
			.stat(readyFile)
			.then(() => true)
			.catch(() => false);
		if (isReady) return;
		await Bun.sleep(10);
	}
	throw new Error(`fixture never became ready: ${readyFile}`);
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

test("probeDaemonLock: no lock file at all reports not live, never throws", async () => {
	const dir = await tmpdir();
	expect(probeDaemonLock(dir)).toEqual({ live: false, owner: null });
});

test("probeDaemonLock: a live owner reports live:true — read-only, never acquires or reclaims", async () => {
	const dir = await tmpdir();
	writeFileSync(path.join(dir, "daemon.lock"), JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: 0 }));
	const probe = probeDaemonLock(dir);
	expect(probe.live).toBe(true);
	expect(probe.owner?.pid).toBe(process.ppid);
	// Read-only: the lock file is untouched, and a real acquire against the SAME dir still sees
	// the live owner and refuses — probing never reclaimed or raced acquireStateLock's own logic.
	await expect(acquireStateLock(dir, { handoffMs: 150 })).rejects.toBeInstanceOf(StateLockError);
});

test("probeDaemonLock: a stale lock (dead pid) reports live:false", async () => {
	const dir = await tmpdir();
	writeFileSync(path.join(dir, "daemon.lock"), JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 }));
	const probe = probeDaemonLock(dir);
	expect(probe.live).toBe(false);
	expect(probe.owner?.pid).toBe(2147483647); // record still surfaced, just not live
});

test("probeDaemonLock: a corrupt lock file degrades to not-live rather than throwing", async () => {
	const dir = await tmpdir();
	writeFileSync(path.join(dir, "daemon.lock"), "not json {{{");
	expect(probeDaemonLock(dir)).toEqual({ live: false, owner: null });
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
	await waitForReadyFile(readyFile); // wait for the holder to actually acquire the fence before racing it

	const handoffMs = 500;
	const t0 = Date.now();
	await expect(acquireStateLock(dir, { handoffMs })).rejects.toBeInstanceOf(StateLockError);
	const elapsedMs = Date.now() - t0;
	// The holder holds for 4s; if we ever blocked in flock(LOCK_EX) itself, this
	// would take ~4s (or hang, for a truly wedged process). Bounded well under that.
	expect(elapsedMs).toBeLessThan(2_000);
});

test("a CORRUPT daemon.lock plus a held fence gives up bounded, never loops forever (#345 round 4, #1a)", async () => {
	// The exact residual codex found in round 3: the deadline was only checked
	// AFTER an EWOULDBLOCK, and giving up with an unreadable lock record
	// returned {kind:"retry"} — which the OUTER loop's `continue` accepted
	// WITHOUT checking the deadline, looping forever. This seeds a genuinely
	// UNPARSEABLE daemon.lock (not a valid stale record) plus a held fence, so
	// give-up-time `readRecord` returns null on every attempt — the exact
	// input that used to spin. The fix's hard, top-of-loop deadline check
	// must still bound this.
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	writeFileSync(file, "not json {{{ — genuinely unparseable, not a stale-but-valid record");
	const readyFile = path.join(dir, "holder-ready");
	const holderChild = path.join(import.meta.dir, "fixtures", "lock-fence-holder-child.ts");
	const holder = Bun.spawn(["bun", holderChild, dir, readyFile], { stdout: "ignore", stderr: "inherit" });
	cleanups.push(async () => {
		holder.kill();
		await holder.exited.catch(() => {});
	});
	await waitForReadyFile(readyFile);

	const handoffMs = 500;
	const t0 = Date.now();
	await expect(acquireStateLock(dir, { handoffMs })).rejects.toBeInstanceOf(StateLockError);
	const elapsedMs = Date.now() - t0;
	// Bounded near handoffMs, not the holder's 4s hold time, and CRITICALLY not
	// a hang — this is the assertion the round-3 code would never have reached.
	expect(elapsedMs).toBeLessThan(2_000);
});

test("acquireFenceOrThrow: an EINTR storm cannot bypass the deadline (#345 round 4, #1b)", async () => {
	// Direct unit test against a fake Flock stub that ALWAYS reports EINTR and
	// NEVER succeeds or reports EWOULDBLOCK — the exact shape that, before the
	// fix, would `continue` straight past the deadline check on every
	// iteration (the check ran only after EWOULDBLOCK) and spin forever.
	// Engineering a genuine signal-interrupted syscall is impractical to do
	// deterministically; this proves the LOOP LOGIC itself is bounded
	// regardless of how EINTR is triggered in practice.
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");
	const fenceFile = reclaimFencePath(file);
	const fd = openSync(fenceFile, "a+");
	cleanups.push(() => closeSync(fd));

	const alwaysEintr: Flock = { lock: () => -1, errno: () => EINTR };
	const deadline = Date.now() + 100;
	const t0 = Date.now();
	await expect(acquireFenceOrThrow(alwaysEintr, fd, file, fenceFile, deadline)).rejects.toBeInstanceOf(StateLockError);
	const elapsedMs = Date.now() - t0;
	// Bounded near the 100ms deadline, not an infinite tight loop.
	expect(elapsedMs).toBeLessThan(1_000);
});

test("recheckLiveBeforeUnsupported: null while stale, the live owner once a peer reclaims (#345 round 4, #2)", async () => {
	// Direct unit test of the TOCTOU re-check itself: process A observes
	// stale, then (in the window before A's fatal "confirmed stale, rm it"
	// error) a peer B reclaims and installs a LIVE record. The re-check must
	// see B's live record, not A's stale snapshot — proving A would take the
	// normal wait/handoff path instead of advising `rm` against a live lock.
	const dir = await tmpdir();
	const file = path.join(dir, "daemon.lock");

	// A's observation: genuinely stale (dead pid).
	writeFileSync(file, JSON.stringify({ pid: 2147483647, host: os.hostname(), startedAt: 0 }));
	expect(recheckLiveBeforeUnsupported(file)).toBeNull();

	// B reclaims in the window and installs a live record (parent process —
	// live and signalable in both host and rootless docker runs, same
	// pattern the "a live owner blocks a second acquire" test above uses).
	writeFileSync(file, JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: 0 }));
	const live = recheckLiveBeforeUnsupported(file);
	expect(live).not.toBeNull();
	expect(live?.owner.pid).toBe(process.ppid);
});

test("probeFlockExclusive only accepts a genuine EWOULDBLOCK/EAGAIN as proof of exclusion (#345 round 4, #3b)", async () => {
	// Before the fix, ANY nonzero return from the second lock attempt was
	// accepted as "exclusive" — even an unrelated failure (EBADF, EINVAL, a
	// transient error) that says nothing about whether flock actually
	// excludes here. A stub whose second lock fails for a DIFFERENT reason
	// must be rejected as inconclusive, not accepted as proof.
	const dir = await tmpdir();
	const testPath = path.join(dir, "errno-probe-target");
	const NOT_EWOULDBLOCK = 9; // EBADF on Linux — deliberately not EWOULDBLOCK/EAGAIN (11)
	let callCount = 0;
	const wrongErrnoStub: Flock = {
		lock: () => {
			callCount++;
			return callCount === 1 ? 0 : -1; // first lock "succeeds", second "fails" for an unrelated reason
		},
		errno: () => NOT_EWOULDBLOCK,
	};
	expect(probeFlockExclusive(wrongErrnoStub, testPath)).toBe(false);
});

test("ensureFlockExclusive caches the exclusivity verdict PER FILESYSTEM DEVICE, not one global flag (#345 round 4, #3a)", async () => {
	// Before the fix, a single global boolean meant a local-disk success on
	// the FIRST state dir made every LATER state dir — even one on a
	// genuinely different, non-exclusive filesystem — skip probing entirely.
	// /tmp and /dev/shm are genuinely different real devices here (confirmed
	// via `stat -c %d`), so this proves per-device isolation without needing
	// root to fabricate a fake mount.
	const tmpDir = await tmpdir();
	const shmDir = await fs.mkdtemp(path.join("/dev/shm", "glance-lock-test-"));
	cleanups.push(() => fs.rm(shmDir, { recursive: true, force: true }));

	const tmpFence = reclaimFencePath(path.join(tmpDir, "daemon.lock"));
	const shmFence = reclaimFencePath(path.join(shmDir, "daemon.lock"));

	const realFlock = loadFlock();
	expect(realFlock).not.toBeNull();
	if (!realFlock) return; // unreachable after the assert above; narrows the type

	// A stub that reports NOT exclusive (the second lock "succeeds" — a no-op,
	// the exact shape of a client-local network mount).
	const nonExclusiveStub: Flock = { lock: () => 0, errno: () => 0 };

	// /tmp: real flock, genuinely exclusive here.
	expect(ensureFlockExclusive(realFlock, tmpFence)).toBe(true);
	// /dev/shm: a DIFFERENT device, probed independently — the fake stub is
	// actually consulted (not skipped via a stale cached verdict from /tmp).
	expect(ensureFlockExclusive(nonExclusiveStub, shmFence)).toBe(false);

	// Re-query each device with the OPPOSITE flock instance: the CACHED verdict
	// per device must win, proving this isn't just "always re-evaluate whatever
	// was passed" — /tmp stays true even handed the non-exclusive stub, and
	// /dev/shm stays false even handed the real, genuinely-working flock.
	expect(ensureFlockExclusive(nonExclusiveStub, tmpFence)).toBe(true);
	expect(ensureFlockExclusive(realFlock, shmFence)).toBe(false);
});
