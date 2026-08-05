/**
 * state-lock.ts — single-writer lock over a squad state dir.
 *
 * Two daemons sharing one state dir race on state.json, receipts, and agent
 * sockets and silently corrupt each other (the port check is no guard: a second
 * daemon on a different `--port` still mutates the shared dir, and even a doomed
 * bind happens AFTER `manager.start()` has already touched disk). So `up`
 * acquires this lock before touching the dir and releases it on shutdown.
 *
 * The lock is a file holding the owner's pid + host + start time. Acquire writes
 * the record to a private temp file then atomically `link`s it into place (so the
 * lock is never observable empty); on EEXIST we read the record and probe
 * liveness with signal 0. A dead owner's lock is stale and reclaimed. A LIVE owner blocks —
 * except during self-upgrade, where the outgoing daemon re-execs its replacement
 * while still briefly alive, so we wait out a short handoff window for it to exit
 * before giving up.
 *
 * Signal 0 only proves a pid EXISTS, not that it's still OUR daemon: after a
 * crash the kernel recycles the pid, and an unrelated process wearing it would
 * look "live" and wedge startup forever. So the record also pins the owner's
 * OS-level start time (Linux /proc/<pid>/stat field 22); on probe we re-read it
 * and a mismatch means the pid was reused → the original owner is gone → stale.
 *
 * ponytail: pid liveness only means anything ON THE SAME HOST, and the reuse
 * guard needs /proc, so it's Linux-only — elsewhere we fall back to bare signal-0
 * (reuse-blind, the prior behaviour). A cross-host lock can't be probed at all, so
 * we treat it as live and refuse — correct for a shared state dir, conservative
 * for a stale one. Upgrade path: a same-host NFS/foreign mount; a portable
 * start-time source for non-Linux.
 *
 * Stale-reclamation fence (lmvdz/glance#345). "The record is stale, unlink it" is
 * a decision made from a snapshot (`readRecord` + `ownerAlive`), and a bare
 * `unlinkSync(file)` afterward removes whatever is AT THAT PATH NOW, not
 * necessarily what was read — the authorization outlives the lock it was granted
 * for. Two racers who both observe the same stale lock can both authorize a
 * reclaim; if D1 unlinks and recreates first, D2's already-authorized unlink
 * deletes D1's brand-new live lock instead, and D2 creates its own — both
 * believe they own the dir. PID reuse produces the identical window.
 *
 * ROUND 1 (rejected in blind gauntlet review). The first fix serialized
 * "observe stale -> unlink" behind a `mkdirSync`/`rmdirSync` mutex with a 5s
 * steal-on-timeout for an abandoned holder. Two independent lineages (codex
 * gpt-5.6-sol, grok-4.5) converged on the same critical: a steal on a timeout
 * is not a fence. If the holder is SIGKILLed mid-critical-section, its mutex
 * dir is orphaned; once EVERY racer's deadline expires, more than one of them
 * can steal + recreate the mutex "simultaneously" (each stealing what looks
 * abandoned from its own vantage point) and both proceed into the decide-and-
 * unlink section at once — reintroducing the exact double-owner outcome the
 * fix existed to prevent. A stolen lock authorizes two holders; that is the
 * textbook fencing failure. The steal was removed entirely, not patched.
 *
 * ROUND 2 (this fix): a real kernel advisory lock (flock(2), via `bun:ffi`
 * against libc), held only for the brief decide-and-unlink-and-recreate
 * section. flock gives what mkdir/rmdir cannot: the kernel — not a wall-clock
 * guess — is the authority on whether the holder is gone, and it releases the
 * lock the instant the holding process exits for ANY reason (normal return,
 * SIGKILL, crash) as part of closing its file descriptors. There is no steal,
 * no timeout, and therefore no window where two processes can believe they
 * hold it. The fence file itself (see {@link reclaimFencePath}) is never
 * deleted — its content is irrelevant; only the OS-level advisory lock on it
 * matters, and that state lives with the kernel, not on disk, so an "abandoned
 * lock file" is not a thing that can exist for flock. (ROUND 3 replaced the
 * blocking `flock(LOCK_EX)` mentioned above with a bounded non-blocking retry
 * — see ROUND 3 #1 below; the fencing property described here is unchanged.)
 *
 * The reclaim section, once inside the flock: re-check for real (a peer may
 * already have reclaimed and recreated between our caller's own `tryCreate`
 * miss and our getting the flock) before trusting anything read earlier. If
 * still stale, unlink and recreate. If our own recreate loses to some third
 * party's fast-path create in the sliver between unlink and recreate, we do
 * NOT assume ownership — we defer and let the outer loop re-observe, exactly
 * as if we'd lost the create race outright. Nobody is ever fooled about who
 * holds the lock.
 *
 * ponytail: flock needs libc, so this is POSIX (Linux confirmed; Darwin via
 * libSystem is wired but untested here). Where it can't be loaded (no FFI /
 * unsupported platform), reclaiming a stale lock isn't attempted at all — we
 * fail closed with a clear, distinct error rather than silently fall back to
 * the TOCTOU-prone bare unlink this fix exists to remove. A brand-new lock
 * (the empty-dir fast path) needs no flock and is unaffected everywhere.
 *
 * ROUND 3 (this fix). A fresh dual-lineage gauntlet (codex gpt-5.6-sol,
 * grok-4.5) confirmed the authority model (both refuted fd-lifetime and
 * FFI-ABI concerns, and confirmed the same-version/local-ext4 race is fixed)
 * but found four boundary failures in round 2:
 *
 * 1. (both, HIGH) A BLOCKING `flock(LOCK_EX)` can wedge boot forever. A
 *    normally-hung daemon is fine (dying/exiting releases the flock), but a
 *    process STOPPED (SIGSTOP) or wedged in a stuck sync syscall while
 *    holding the fence blocks every future acquirer in the libc call itself —
 *    before our deadline is ever consulted. Fixed: `LOCK_EX|LOCK_NB`, retried
 *    with `Bun.sleep` against a BOUNDED deadline (the same `handoffMs` the
 *    live-owner wait already uses); on timeout we give up and fail closed
 *    with {@link StateLockError} WITHOUT ever entering the critical section —
 *    fencing intact (a loser gives up, never steals) and boot bounded. EINTR
 *    retries immediately with no sleep; any other errno is a real error.
 *
 * 2. (codex, HIGH) `loadFlock()` used to run BEFORE `ownerAlive()`, so on a
 *    platform where flock can't load, ANY existing lock — including a LIVE
 *    daemon's — was mislabeled "stale" and the error told the operator to
 *    `rm` it by hand. Following that advice against a live lock is exactly
 *    the two-writer outcome this module exists to prevent. Fixed:
 *    `acquireStateLock` now classifies via `readRecord`/`ownerAlive` FIRST,
 *    with no flock involved at all — a live owner always takes the normal
 *    wait/handoff path, full stop. flock is only ever consulted after a
 *    same-process observation of genuine staleness, and even then the
 *    reclaim section re-reads and re-checks liveness again before acting.
 *    Also widened the musl (Alpine) dlopen candidates — `libc.so.6` doesn't
 *    exist there.
 *
 * 3. (both, HIGH) A mount where flock is a client-local no-op (e.g. NFS with
 *    `local_lock=flock`, or `local_lock=all`) would let two HOSTS both
 *    "acquire" the same fence, silently restoring the original interleaving
 *    with zero indication anything was wrong. Fixed: a self-test —
 *    {@link probeFlockExclusive} opens the fence file twice in this process
 *    and asserts the second `LOCK_EX|LOCK_NB` actually fails with
 *    EWOULDBLOCK/EAGAIN. If it unexpectedly SUCCEEDS, flock isn't providing
 *    real exclusion here and we fail closed with
 *    {@link StateLockReclaimUnsupportedError} rather than trust it. A local
 *    filesystem for `GLANCE_STATE_DIR` is the supported, documented contract
 *    (docs/operations.md); `warnOnNetworkFilesystem` gives an early, cheap
 *    (`/proc/mounts`) heads-up when one is detected, though the self-test —
 *    not the warning — is the actual correctness backstop.
 *
 * 4. (both, MEDIUM) A SIGKILLed ROUND 1 (mkdir-mutex) daemon leaves
 *    `<file>.reclaim` behind as a DIRECTORY. `openSync(reclaimFile, "a+")`
 *    on a directory throws EISDIR. Fixed: the fence now lives at a NEW
 *    filename, `<file>.fence`, so round 1's directory at the old path is
 *    never opened by this code at all; `cleanupRound1Debris` opportunistically
 *    removes a leftover directory there if one exists (best-effort, never
 *    fatal — round 1 never actually shipped, so this is defense-in-depth).
 *
 * 5. (grok) The self-test in #3 is exported ({@link probeFlockExclusive}) and
 *    unit-tested directly against BOTH the real flock (must return true on
 *    this filesystem) and a deliberately no-op stub (must return false) — so
 *    a regression that silently breaks the exclusion check fails the suite
 *    even if the slower multi-process race test doesn't happen to hit it.
 *
 * ROLLOUT NOTE (codex, out of scope here — lmvdz/glance#352): an old,
 * unprotected (pre-#345) daemon binary doesn't know about the fence at all
 * and can still race a new one during a mixed-version upgrade window. This
 * code can't retroactively fence a binary that predates the fence; #352
 * tracks the rollout/version-gate question separately.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync, statSync, rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";

const LOCK_FILE = "daemon.lock";
/** How long to wait for an outgoing (upgrading) daemon to release before giving up. */
const HANDOFF_TIMEOUT_MS = 5_000;
const HANDOFF_POLL_MS = 200;

interface LockRecord {
	pid: number;
	host: string;
	startedAt: number;
	/** Launcher pid + command line, so a daemon started outside up.sh (a rogue) is traceable. */
	ppid?: number;
	argv?: string;
	/** OS-level process start time (Linux /proc/<pid>/stat field 22, clock ticks since boot), to distinguish a reused pid from the original owner. */
	proc?: number;
}

export interface StateLock {
	/** Absolute path of the lock file held. */
	readonly file: string;
	/** Release the lock (idempotent). Safe to call from a signal handler. */
	release(): void;
}

export class StateLockError extends Error {
	constructor(
		public readonly lockFile: string,
		public readonly owner: LockRecord,
	) {
		super(
			`another glance daemon (pid ${owner.pid} on ${owner.host}) is already using this state dir.\n` +
				`  lock: ${lockFile}\n` +
				`  stop it first, or run with a different GLANCE_STATE_DIR.`,
		);
		this.name = "StateLockError";
	}
}

/** Thrown when a lock has been CONFIRMED stale (its owner failed `ownerAlive`,
 * checked before this error is ever considered — see the ROUND 3 #2 note in the
 * module docstring) but reclaiming it can't be done safely: either no kernel
 * advisory lock is available on this platform, or one loaded but failed the
 * {@link probeFlockExclusive} self-test (flock is a no-op on this filesystem —
 * see ROUND 3 #3). Fails closed rather than risk the TOCTOU this module exists
 * to close — distinct from {@link StateLockError} (a live or contested owner)
 * so the operator gets an accurate, actionable message. */
export class StateLockReclaimUnsupportedError extends Error {
	constructor(
		public readonly lockFile: string,
		public readonly reason: "no-flock" | "flock-not-exclusive",
	) {
		const why =
			reason === "no-flock"
				? "this platform has no kernel advisory lock (flock) available"
				: "flock on this filesystem doesn't actually provide mutual exclusion (e.g. an NFS mount " +
					"with client-local locking) — trusting it would silently reintroduce a double-owner race";
		super(
			`${lockFile}'s owner is confirmed gone, but it can't be reclaimed safely: ${why}.\n` +
				`  If you're SURE no other glance daemon is using this state dir (check from every host, ` +
				`not just this one), remove the file by hand and retry:\n    rm ${lockFile}\n` +
				`  GLANCE_STATE_DIR should point at a local filesystem — see docs/operations.md.\n`,
		);
		this.name = "StateLockReclaimUnsupportedError";
	}
}

function lockPath(stateDir: string): string {
	return path.join(stateDir, LOCK_FILE);
}

/** Path of the persistent flock target guarding the reclaim decision (see the
 * ROUND 2 note above). Never deleted; its content is unused — only the OS-level
 * advisory lock on its file descriptor matters. Deliberately NOT `<file>.reclaim`
 * — round 1's (rejected) mkdir-mutex design used that exact path as a
 * DIRECTORY, and a daemon that crashed mid-round-1 could leave that directory
 * behind; opening a directory with `"a+"` throws EISDIR (ROUND 3 #4). A new
 * filename means this code never touches that path at all.
 * @substrate exported for tests only — `tests/state-lock.test.ts` and its
 * `lock-fence-holder-child.ts` fixture use it to exercise the fence directly
 * (e.g. simulating a wedged holder); `reclaimOrCreate` (same file) is the one
 * production caller. */
export function reclaimFencePath(file: string): string {
	return `${file}.fence`;
}

/** Best-effort cleanup of debris from the REJECTED round-1 design: a directory
 * left at `<file>.reclaim` by a daemon that crashed mid-round-1. Round 1 never
 * actually shipped to any real deployment, so this is defense-in-depth, not a
 * load-bearing fix — never fatal either way. */
function cleanupRound1Debris(file: string): void {
	const oldPath = `${file}.reclaim`;
	try {
		if (statSync(oldPath).isDirectory()) rmdirSync(oldPath);
	} catch {
		// Doesn't exist, isn't a directory, or isn't removable (not empty, perms) — leave it.
	}
}

/** Network filesystems whose `flock` support is commonly client-local or a
 * no-op (ROUND 3 #3) — NFS confirmed by the gauntlet; the others are the same
 * class of risk. This is only used for an early, cheap, best-effort WARNING;
 * {@link probeFlockExclusive} is the actual correctness backstop regardless of
 * whether this detection fires. */
const NETWORK_FS_TYPES = new Set(["nfs", "nfs4", "cifs", "smb", "smbfs", "9p", "afs", "ncpfs"]);

let networkFsWarned = false;

/** Best-effort (Linux `/proc/mounts`; silently a no-op elsewhere or on any
 * read/parse failure): warn once if `dirPath` looks like it's on a network
 * filesystem. GLANCE_STATE_DIR must be a local filesystem — see docs/operations.md. */
function warnOnNetworkFilesystem(dirPath: string): void {
	if (networkFsWarned) return;
	try {
		const mounts = readFileSync("/proc/mounts", "utf8");
		let best: { mountPoint: string; fsType: string } | null = null;
		for (const line of mounts.split("\n")) {
			const parts = line.split(" ");
			if (parts.length < 3) continue;
			const mountPoint = parts[1];
			const fsType = parts[2];
			if ((dirPath === mountPoint || dirPath.startsWith(`${mountPoint}/`)) && (!best || mountPoint.length > best.mountPoint.length)) {
				best = { mountPoint, fsType };
			}
		}
		if (best && NETWORK_FS_TYPES.has(best.fsType)) {
			networkFsWarned = true;
			process.stderr.write(
				`WARNING: ${dirPath} looks like it's on a network filesystem (${best.fsType}, mounted at ` +
					`${best.mountPoint}). glance's stale-lock reclamation relies on flock(2) providing REAL ` +
					`cross-host mutual exclusion, which some network mounts silently do not (e.g. NFS with ` +
					`local_lock=flock/all makes it client-local). glance self-tests this and fails closed if ` +
					`flock doesn't actually exclude here, but a local filesystem is the supported, ` +
					`recommended setup for GLANCE_STATE_DIR — see docs/operations.md.\n`,
			);
		}
	} catch {
		// No /proc/mounts (non-Linux) or unreadable — best-effort only, never fatal.
	}
}

/** Linux process start time (clock ticks since boot, /proc/<pid>/stat field 22), or null when /proc is unavailable or the pid is gone. */
function procStartTime(pid: number): number | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm (field 2) is parenthesized and may itself contain spaces or ')',
		// so anchor parsing after the LAST ')': what follows is "state ppid …".
		const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		// field 3 (state) is after[0]; field 22 (starttime) is after[19].
		const start = Number(after[19]);
		return Number.isFinite(start) ? start : null;
	} catch {
		return null;
	}
}

function selfRecord(): LockRecord {
	return {
		pid: process.pid,
		ppid: process.ppid,
		host: os.hostname(),
		startedAt: Date.now(),
		proc: procStartTime(process.pid) ?? undefined,
		argv: process.argv.slice(1).join(" "),
	};
}

function readRecord(file: string): LockRecord | null {
	try {
		const rec = JSON.parse(readFileSync(file, "utf8")) as Partial<LockRecord>;
		if (typeof rec.pid === "number" && typeof rec.host === "string") {
			return {
				pid: rec.pid,
				host: rec.host,
				startedAt: rec.startedAt ?? 0,
				proc: typeof rec.proc === "number" ? rec.proc : undefined,
			};
		}
	} catch {
		// Missing or garbage lock file — treat as no owner so a corrupt lock never wedges startup.
	}
	return null;
}

/** True if the recorded owner is (probably) still running. Cross-host owners are assumed live. */
function ownerAlive(rec: LockRecord): boolean {
	if (rec.host !== os.hostname()) return true; // can't probe another host's pid
	if (rec.pid === process.pid) return false; // our own stale record from a previous incarnation
	try {
		process.kill(rec.pid, 0); // signal 0: existence/permission probe, sends nothing
	} catch (err) {
		// ESRCH → gone. EPERM → exists but owned by another user; fall through to the reuse check.
		if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	// The pid exists, but after a crash the kernel may have recycled it onto an
	// unrelated process. If we pinned the owner's OS start time, a mismatch proves
	// the pid was reused and the original daemon is gone. (No pin / no /proc → keep
	// the conservative "alive" answer rather than risk reclaiming a live lock.)
	if (rec.proc != null) {
		const cur = procStartTime(rec.pid);
		if (cur != null && cur !== rec.proc) return false;
	}
	return true;
}

/** Atomically create the lock file with our record. Returns false on EEXIST, throws on other errors. */
function tryCreate(file: string): boolean {
	// Write our record to a private temp file, then atomically link it into place.
	// link() fails with EEXIST when `file` already exists, and the instant `file`
	// becomes visible it already holds the full record. openSync(wx)+writeSync had
	// an empty-file window between create and write: a racing daemon could see the
	// empty file, JSON.parse it to null, judge the lock corrupt/stale, unlink it,
	// and create its own — both daemons then "own" the dir (TOCTOU). link() closes
	// that window because the lock file is never observable in an empty state.
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
	const fd = openSync(tmp, "wx");
	try {
		writeSync(fd, JSON.stringify(selfRecord()));
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(tmp, file);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			// Best-effort cleanup of our temp file; a leftover is harmless.
		}
	}
}

// --- flock(2) via bun:ffi -----------------------------------------------------
// No new dependency: libc is always present where these libraries resolve.
// Loaded lazily (and once) so a platform without it only pays for the attempt
// the first time a reclaim is actually needed, not on every boot.

const LOCK_EX = 2;
const LOCK_UN = 8;
const LOCK_NB = 4;

// errno values are the same across the POSIX platforms this targets EXCEPT
// EAGAIN/EWOULDBLOCK, which differ between Linux (11) and Darwin/BSD (35) —
// on both platforms EAGAIN and EWOULDBLOCK are the same value, so one check
// per platform covers both names.
const EINTR = 4;
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

/** Exported so {@link probeFlockExclusive} can be unit-tested against a
 * deliberately no-op stub (ROUND 3 #5), not just the real loaded flock. */
export interface Flock {
	/** Raw `flock(2)`: 0 on success, -1 on failure (check `errno()`). */
	lock(fd: number, op: number): number;
	/** Current `errno`, valid only immediately after a `lock()` call returned -1. */
	errno(): number;
}

let flock: Flock | null | undefined; // undefined = not yet attempted

/** Exported so tests can get the REAL flock binding directly, to validate
 * {@link probeFlockExclusive} against genuine flock semantics on this
 * filesystem (ROUND 3 #5) rather than only against a stub.
 * @substrate exported for tests only — `reclaimOrCreate` (same file) is the
 * one production caller; `tests/state-lock.test.ts` and
 * `lock-fence-holder-child.ts` are the only out-of-file callers. */
export function loadFlock(): Flock | null {
	if (flock !== undefined) return flock;
	// musl (Alpine) has no libc.so.6/libc.so, hence the arch-specific sonames —
	// glibc candidates are tried first since they're far more common.
	const muslArch =
		{ x64: "x86_64", arm64: "aarch64", ia32: "x86", arm: "arm" }[process.arch as string] ?? process.arch;
	const candidates =
		process.platform === "darwin"
			? ["libSystem.B.dylib"]
			: ["libc.so.6", "libc.so", `libc.musl-${muslArch}.so.1`, "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];
	for (const name of candidates) {
		try {
			const lib = dlopen(name, {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			flock = {
				lock: (fd, op) => lib.symbols.flock(fd, op),
				errno: () => {
					const errnoPtr = lib.symbols.__errno_location();
					if (!errnoPtr) throw new Error("__errno_location returned null");
					return read.i32(errnoPtr, 0);
				},
			};
			return flock;
		} catch {
			// Try the next candidate library name.
		}
	}
	flock = null;
	return null;
}

/**
 * ROUND 3 #3/#5: does flock actually provide mutual exclusion for `testPath` on
 * whatever filesystem it lives on? Opens it TWICE in this process and confirms
 * the second `LOCK_EX|LOCK_NB` fails with EWOULDBLOCK/EAGAIN. Some mounts (NFS
 * with `local_lock=flock`/`all`, or other misconfigured network filesystems)
 * make flock a client-local no-op — both "acquire" it and the original
 * double-owner race returns silently. Exported so it can be unit-tested
 * directly against both the real flock (expect true) and a deliberately no-op
 * stub (expect false) — a regression here must fail the suite even if the
 * slower multi-process race test doesn't happen to reproduce it.
 * @substrate exported for tests only — `ensureFlockExclusive` (same file) is
 * the one production caller; `tests/state-lock.test.ts` is the only
 * out-of-file caller, asserting this function directly against both a real
 * and a stubbed flock (ROUND 3 #5 — the suite must fail if this regresses).
 */
export function probeFlockExclusive(f: Flock, testPath: string): boolean {
	const fd1 = openSync(testPath, "a+");
	const fd2 = openSync(testPath, "a+");
	try {
		if (f.lock(fd1, LOCK_EX | LOCK_NB) !== 0) return false; // couldn't even get the first — treat as unusable
		try {
			if (f.lock(fd2, LOCK_EX | LOCK_NB) === 0) {
				f.lock(fd2, LOCK_UN); // it "succeeded" — not exclusive; release before reporting failure
				return false;
			}
			return true; // expected: second lock failed (EWOULDBLOCK/EAGAIN) — genuinely exclusive
		} finally {
			f.lock(fd1, LOCK_UN);
		}
	} finally {
		closeSync(fd1);
		closeSync(fd2);
	}
}

let flockExclusiveVerified: boolean | undefined; // cached per process — the mount doesn't change mid-run

function ensureFlockExclusive(f: Flock, fenceFile: string): boolean {
	if (flockExclusiveVerified !== undefined) return flockExclusiveVerified;
	// Probe a DEDICATED path, never the live fence file: the fence can be
	// legitimately held by another racer at any moment (that's the whole
	// point of it), and `probeFlockExclusive`'s first lock attempt failing
	// because of real contention is not evidence flock is broken — it would
	// misclassify an ordinary busy fence as "unsupported". A sibling path on
	// the same directory (same mount) is representative of the same
	// filesystem's flock behavior without ever colliding with real traffic.
	flockExclusiveVerified = probeFlockExclusive(f, `${fenceFile}.selftest`);
	return flockExclusiveVerified;
}

type ReclaimOutcome = { kind: "created" } | { kind: "retry" } | { kind: "live"; owner: LockRecord };

const RECLAIM_POLL_MS = 20;

/**
 * Reclaim-and-create, holding a real kernel advisory lock (flock) for the
 * whole decide-and-act section (see the ROUND 2/3 notes in the module
 * docstring). Only one process anywhere can be inside the critical section at
 * a time for a given `file` — the kernel enforces it and releases it the
 * instant a holder exits, by any means, with no timeout and no steal.
 *
 * The flock itself is acquired non-blockingly (`LOCK_EX|LOCK_NB`) and retried
 * against `deadline` (ROUND 3 #1) — never a blocking `LOCK_EX`, which would
 * let a STOPPED or wedged holder block every future boot forever with no
 * bound. On timeout we give up WITHOUT ever entering the critical section:
 * fencing is intact (we never steal, we just don't take it) and boot is
 * bounded either way.
 *
 * Throws {@link StateLockReclaimUnsupportedError} if no advisory lock is
 * available, or if one loaded but failed {@link probeFlockExclusive}.
 */
async function reclaimOrCreate(file: string, deadline: number): Promise<ReclaimOutcome> {
	const f = loadFlock();
	if (!f) throw new StateLockReclaimUnsupportedError(file, "no-flock");

	cleanupRound1Debris(file);
	const fenceFile = reclaimFencePath(file);
	if (!ensureFlockExclusive(f, fenceFile)) throw new StateLockReclaimUnsupportedError(file, "flock-not-exclusive");

	const fd = openSync(fenceFile, "a+"); // create if missing; content is never used
	try {
		for (;;) {
			const ret = f.lock(fd, LOCK_EX | LOCK_NB);
			if (ret === 0) break; // acquired
			const errno = f.errno();
			if (errno === EINTR) continue; // interrupted syscall — retry immediately, no sleep
			if (errno !== EWOULDBLOCK) throw new Error(`flock(LOCK_EX|LOCK_NB) on ${fenceFile} failed with errno ${errno}`);
			if (Date.now() >= deadline) {
				// Someone (or something stuck/stopped) has held the fence past our
				// whole budget. We never entered the critical section, so we can't
				// have stomped anything — give up and report the most current view.
				const current = readRecord(file);
				return current ? { kind: "live", owner: current } : { kind: "retry" };
			}
			await Bun.sleep(RECLAIM_POLL_MS);
		}
		try {
			// A peer may have reclaimed and recreated between our caller's own
			// tryCreate miss and our getting the flock — check for real.
			if (tryCreate(file)) return { kind: "created" };
			const rec = readRecord(file);
			if (!rec || !ownerAlive(rec)) {
				// Stale (owner dead/unreadable), re-confirmed under the fence. While
				// we hold it, no other racer can be inside this section — safe to unlink.
				try {
					unlinkSync(file);
				} catch {
					// Shouldn't happen while we hold the flock; tolerate it regardless.
				}
				// If our own recreate loses to a third party's fast-path create in
				// this sliver, do NOT assume ownership — defer, same as losing the
				// create race outright.
				if (tryCreate(file)) return { kind: "created" };
				return { kind: "retry" };
			}
			return { kind: "live", owner: rec };
		} finally {
			f.lock(fd, LOCK_UN);
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * Acquire the single-writer lock for `stateDir`. Resolves with a handle whose
 * `release()` deletes the lock. Throws {@link StateLockError} if a live daemon
 * already holds it (after waiting out the upgrade handoff window), or
 * {@link StateLockReclaimUnsupportedError} if a stale lock is found but this
 * platform can't reclaim it safely.
 */
export async function acquireStateLock(stateDir: string, opts: { handoffMs?: number } = {}): Promise<StateLock> {
	await fs.mkdir(stateDir, { recursive: true });
	warnOnNetworkFilesystem(stateDir); // best-effort, cheap, non-fatal — see ROUND 3 #3
	const file = lockPath(stateDir);
	const deadline = Date.now() + (opts.handoffMs ?? HANDOFF_TIMEOUT_MS);

	for (;;) {
		// Fast, uncontended path: no flock needed when the lock file simply isn't
		// there yet (the common case — no stale lock to race over at all). Safe on
		// its own: tryCreate's link()-based create is already an atomic CAS across
		// any number of simultaneous callers.
		if (tryCreate(file)) break;

		// Classify BEFORE touching flock at all (ROUND 3 #2): a live owner never
		// needs flock, and must never be mislabeled "stale" just because flock/
		// libc happens to be unavailable on this platform. Only a same-process
		// observation of genuine staleness ever proceeds to the flock-guarded
		// reclaim, which re-confirms staleness again before acting.
		const observed = readRecord(file);
		if (observed && ownerAlive(observed)) {
			if (Date.now() >= deadline) throw new StateLockError(file, observed);
			await Bun.sleep(HANDOFF_POLL_MS);
			continue;
		}

		const outcome = await reclaimOrCreate(file, deadline);
		if (outcome.kind === "created") break;
		if (outcome.kind === "retry") continue;

		// Either a peer legitimately won the reclaim, or we gave up waiting on the
		// fence (ROUND 3 #1) and `file` currently shows some owner. During upgrade
		// the outgoing daemon dies within the handoff window; a genuine
		// double-start never will, so we eventually throw.
		if (Date.now() >= deadline) throw new StateLockError(file, outcome.owner);
		await Bun.sleep(HANDOFF_POLL_MS);
	}

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const rec = readRecord(file);
		// Only delete a lock we still own — never clobber a successor that reclaimed it.
		if (rec && rec.pid === process.pid && rec.host === os.hostname()) {
			try {
				unlinkSync(file);
			} catch {
				// Already gone — nothing to do.
			}
		}
	};
	// Cover paths that bypass the normal shutdown handler (e.g. upgrade's process.exit).
	process.once("exit", release);
	return { file, release };
}
