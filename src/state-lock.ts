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
 * hold it. `flock(LOCK_EX)` blocks in the kernel's wait queue, so there's no
 * poll loop either. The lock file itself (`daemon.lock.reclaim`) is never
 * deleted — its content is irrelevant; only the OS-level advisory lock on it
 * matters, and that state lives with the kernel, not on disk, so an "abandoned
 * lock file" is not a thing that can exist for flock.
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
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dlopen, FFIType } from "bun:ffi";

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

/** Thrown when a lock LOOKS stale but reclaiming it can't be done safely on this
 * platform (no kernel advisory lock available). Fails closed rather than risk
 * the TOCTOU this module exists to close — distinct from {@link StateLockError}
 * (a genuinely live owner) so the operator gets an accurate, actionable message. */
export class StateLockReclaimUnsupportedError extends Error {
	constructor(public readonly lockFile: string) {
		super(
			`${lockFile} looks stale (its owner appears gone), but this platform has no kernel ` +
				`advisory lock (flock) available to reclaim it safely.\n` +
				`  If you're sure no other glance daemon is using this state dir, remove the file ` +
				`by hand and retry:\n    rm ${lockFile}\n`,
		);
		this.name = "StateLockReclaimUnsupportedError";
	}
}

function lockPath(stateDir: string): string {
	return path.join(stateDir, LOCK_FILE);
}

/** Path of the persistent flock target guarding the reclaim decision (see the
 * ROUND 2 note above). Never deleted; its content is unused — only the OS-level
 * advisory lock on its file descriptor matters. */
function reclaimLockPath(file: string): string {
	return `${file}.reclaim`;
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

type FlockFn = (fd: number, op: number) => number;

let flockFn: FlockFn | null | undefined; // undefined = not yet attempted

function loadFlock(): FlockFn | null {
	if (flockFn !== undefined) return flockFn;
	// musl (Alpine) has no libc.so.6, hence the second Linux candidate.
	const candidates = process.platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const name of candidates) {
		try {
			const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
			flockFn = (fd, op) => lib.symbols.flock(fd, op);
			return flockFn;
		} catch {
			// Try the next candidate library name.
		}
	}
	flockFn = null;
	return null;
}

type ReclaimOutcome = { kind: "created" } | { kind: "retry" } | { kind: "live"; owner: LockRecord };

/**
 * Reclaim-and-create, holding a real kernel advisory lock (flock) for the
 * whole decide-and-act section (see the ROUND 2 note in the module docstring).
 * Only one process anywhere can be inside this function's try block at a time
 * for a given `file` — the kernel enforces it and releases it the instant a
 * holder exits, by any means, with no timeout and no steal. Throws
 * {@link StateLockReclaimUnsupportedError} if no advisory lock is available.
 */
function reclaimOrCreate(file: string): ReclaimOutcome {
	const flock = loadFlock();
	if (!flock) throw new StateLockReclaimUnsupportedError(file);

	const reclaimFile = reclaimLockPath(file);
	const fd = openSync(reclaimFile, "a+"); // create if missing; content is never used
	try {
		const ret = flock(fd, LOCK_EX); // blocks in the kernel's wait queue until we hold it exclusively
		if (ret !== 0) throw new Error(`flock(LOCK_EX) failed with code ${ret}`);
		try {
			// A peer may have reclaimed and recreated between our caller's own
			// tryCreate miss and our getting the flock — check for real.
			if (tryCreate(file)) return { kind: "created" };
			const rec = readRecord(file);
			if (!rec || !ownerAlive(rec)) {
				// Stale (owner dead/unreadable). While we hold the flock, no other
				// racer can be inside this section — safe to unlink.
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
			flock(fd, LOCK_UN);
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
	const file = lockPath(stateDir);
	const deadline = Date.now() + (opts.handoffMs ?? HANDOFF_TIMEOUT_MS);

	for (;;) {
		// Fast, uncontended path: no flock needed when the lock file simply isn't
		// there yet (the common case — no stale lock to race over at all). Safe on
		// its own: tryCreate's link()-based create is already an atomic CAS across
		// any number of simultaneous callers.
		if (tryCreate(file)) break;

		const outcome = reclaimOrCreate(file);
		if (outcome.kind === "created") break;
		if (outcome.kind === "retry") continue;

		// A live owner holds it. During upgrade the outgoing daemon dies within the
		// handoff window; a genuine double-start never will, so we eventually throw.
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
