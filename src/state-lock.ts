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
 * Stale-reclamation fence (lmvdz/glance#345): "the record is stale, unlink it" is
 * a decision made from a snapshot (a `readRecord` + `ownerAlive` check), and a
 * bare `unlinkSync(file)` afterward removes whatever is AT THAT PATH NOW, not
 * necessarily what was read — the authorization outlives the lock it was granted
 * for. Two racers who both observe the same stale lock can both authorize a
 * reclaim; if D1 unlinks and recreates first, D2's already-authorized unlink
 * deletes D1's brand-new live lock instead, and D2 creates its own — both
 * believe they own the dir. PID reuse produces the identical window.
 *
 * The fix serializes "observe stale -> unlink" behind `reclaimMutex`, a plain
 * `mkdirSync`/`rmdirSync` mutex (mkdir is exclusive-create, same as the
 * link-based create above, so it needs no new primitive or dependency). Only one
 * process at a time can be inside the decide-and-unlink section; every other
 * racer either blocks on the mutex or, once it gets in, re-reads the CURRENT
 * file state before acting — so nobody ever unlinks a lock they didn't just
 * observe as stale a moment before, with no other reclaimer able to interleave.
 * A racer that loses out (because a peer's create won first) simply falls
 * through to the normal live-owner wait/timeout path — it never deletes what it
 * lost to.
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync, mkdirSync, rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

function lockPath(stateDir: string): string {
	return path.join(stateDir, LOCK_FILE);
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

/** Directory that doubles as a mutex guarding the stale-reclaim decision (see the
 * fence note in the module docstring). `mkdirSync` is exclusive-create — EEXIST
 * when it already exists — so it's a correct mutual-exclusion primitive on every
 * platform Node supports, with no new dependency. */
function reclaimMutexPath(file: string): string {
	return `${file}.reclaim`;
}

/** How long to wait for a peer's reclaim mutex before assuming it's abandoned.
 * The section it guards is a handful of synchronous fs calls with no `await` in
 * between, so a holder can only get stuck here if it was killed mid-syscall —
 * vanishingly rare — but a crash there must not wedge every future boot. */
const RECLAIM_MUTEX_STEAL_MS = 5_000;
const RECLAIM_MUTEX_POLL_MS = 10;

/** Block until we hold the reclaim mutex for `file`. Returns a release function. */
async function acquireReclaimMutex(file: string): Promise<() => void> {
	const dir = reclaimMutexPath(file);
	const deadline = Date.now() + RECLAIM_MUTEX_STEAL_MS;
	for (;;) {
		try {
			mkdirSync(dir);
			return () => {
				try {
					rmdirSync(dir);
				} catch {
					// Already gone — nothing to do.
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() >= deadline) {
				// The holder appears abandoned (crashed mid-critical-section). Steal
				// rather than wedge every future boot forever; worst case is a benign
				// re-check, not a lost lock, since the section re-reads current state.
				try {
					rmdirSync(dir);
				} catch {
					// A peer stole/removed it first — loop and race mkdir again.
				}
				continue;
			}
			await Bun.sleep(RECLAIM_MUTEX_POLL_MS);
		}
	}
}

type ReclaimOutcome = { kind: "created" } | { kind: "retry" } | { kind: "live"; owner: LockRecord };

/**
 * Under the reclaim mutex: try to create fresh (a peer may already have
 * reclaimed and recreated since our caller's own tryCreate failed), otherwise
 * re-read the CURRENT record and, only if it's still stale, unlink it. Because
 * this whole read-then-unlink sequence is serialized against every other
 * racer, nothing can create a fresh lock at `file` between our read and our
 * unlink — so we can never remove a lock we didn't just observe as stale.
 */
async function tryReclaimOrCreate(file: string, testOnlyReclaimDelayMs?: number): Promise<ReclaimOutcome> {
	const release = await acquireReclaimMutex(file);
	try {
		if (tryCreate(file)) return { kind: "created" };
		const rec = readRecord(file);
		if (!rec || !ownerAlive(rec)) {
			// Stale (owner dead/unreadable), and — because we hold the mutex — no
			// other racer can be mid-decision right now. Safe to unlink.
			if (testOnlyReclaimDelayMs) await Bun.sleep(testOnlyReclaimDelayMs);
			try {
				unlinkSync(file);
			} catch {
				// Shouldn't happen while we hold the mutex; tolerate it regardless.
			}
			return { kind: "retry" };
		}
		return { kind: "live", owner: rec };
	} finally {
		release();
	}
}

/**
 * Acquire the single-writer lock for `stateDir`. Resolves with a handle whose
 * `release()` deletes the lock. Throws {@link StateLockError} if a live daemon
 * already holds it (after waiting out the upgrade handoff window).
 */
export async function acquireStateLock(
	stateDir: string,
	opts: {
		handoffMs?: number;
		/**
		 * @internal test-only. Widens the window between "determined the lock is
		 * stale" and "removed it" so a reproduction test can force two reclaimers to
		 * interleave deterministically instead of racing on real (sub-millisecond)
		 * scheduling luck. Zero/unset in every real caller — never set this outside
		 * a test.
		 */
		testOnlyReclaimDelayMs?: number;
	} = {},
): Promise<StateLock> {
	await fs.mkdir(stateDir, { recursive: true });
	const file = lockPath(stateDir);
	const deadline = Date.now() + (opts.handoffMs ?? HANDOFF_TIMEOUT_MS);

	for (;;) {
		// Fast, uncontended path: no mutex needed when the lock file simply isn't
		// there yet (the common case — no stale lock to race over at all).
		if (tryCreate(file)) break;

		const outcome = await tryReclaimOrCreate(file, opts.testOnlyReclaimDelayMs);
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
