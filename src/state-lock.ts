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
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, linkSync } from "node:fs";
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

/**
 * Acquire the single-writer lock for `stateDir`. Resolves with a handle whose
 * `release()` deletes the lock. Throws {@link StateLockError} if a live daemon
 * already holds it (after waiting out the upgrade handoff window).
 */
export async function acquireStateLock(stateDir: string, opts: { handoffMs?: number } = {}): Promise<StateLock> {
	await fs.mkdir(stateDir, { recursive: true });
	const file = lockPath(stateDir);
	const deadline = Date.now() + (opts.handoffMs ?? HANDOFF_TIMEOUT_MS);

	for (;;) {
		if (tryCreate(file)) break;

		const rec = readRecord(file);
		if (!rec || !ownerAlive(rec)) {
			// Stale lock (owner gone or unreadable). Reclaim it and retry the create.
			try {
				unlinkSync(file);
			} catch {
				// Lost the race to another reclaimer — loop and re-evaluate.
			}
			continue;
		}

		// A live owner holds it. During upgrade the outgoing daemon dies within the
		// handoff window; a genuine double-start never will, so we eventually throw.
		if (Date.now() >= deadline) throw new StateLockError(file, rec);
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
