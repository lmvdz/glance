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
 * ROLLOUT NOTE (codex, out of scope here — lmvdz/glance#350): an old,
 * unprotected (pre-#345) daemon binary doesn't know about the fence at all
 * and can still race a new one during a mixed-version upgrade window. This
 * code can't retroactively fence a binary that predates the fence; #350
 * tracks the rollout/version-gate question separately. (An earlier duplicate,
 * #352, was filed independently and consolidated into #350 by the repo
 * owner — #350 is canonical.)
 *
 * ROUND 4 (this fix). A scoped delta-verify of round 3 (codex) closed EISDIR
 * (#4 above) but found residual depth in the other three:
 *
 * 1. (BOOT-HANG, still open) The round-3 deadline check ran only after an
 *    EWOULDBLOCK, so two paths escaped it: (a) a corrupt/unreadable
 *    `daemon.lock` at give-up time made `reclaimOrCreate` return `{kind:
 *    "retry"}`, and the OUTER loop's `continue` for "retry" never checked
 *    the deadline — an infinite loop with a held fence and a corrupt lock
 *    file; (b) EINTR retried via `continue` BEFORE the deadline check, so an
 *    EINTR storm could bypass it entirely. Fixed: {@link acquireFenceOrThrow}
 *    checks the deadline FIRST on every loop iteration — before the flock
 *    attempt, before any retry path — and throws {@link StateLockError}
 *    directly the instant it's exceeded, never entering the critical section
 *    and never returning an ambiguous "keep going" signal for the outer loop
 *    to mishandle. One check governs every exit path.
 *
 * 2. (LIBC-ABSENT LIVE-OWNER TOCTOU, still open) Round 3 fixed the INITIAL
 *    observation ordering but left a window: process A observes stale, then
 *    calls `loadFlock()`/`ensureFlockExclusive` and hits the unsupported
 *    path — but a peer could have reclaimed and installed a LIVE record in
 *    that exact window, and A would still throw the fatal "confirmed stale,
 *    rm it by hand" error against a lock that is live RIGHT NOW. Fixed:
 *    {@link recheckLiveBeforeUnsupported} re-reads and re-checks liveness
 *    immediately before either unsupported-error throw site; if the lock has
 *    gone live, A takes the normal wait/handoff path instead — the fatal
 *    error is only ever thrown against a lock re-confirmed stale at the
 *    instant of throwing.
 *
 * 3. (MOUNT-LOCAL, split) Five fixable defects in {@link probeFlockExclusive}
 *    / {@link ensureFlockExclusive}: (a) the exclusivity verdict was cached
 *    in ONE global boolean, so a local-disk success made every later state
 *    dir on any OTHER filesystem (including a genuinely non-exclusive one)
 *    skip probing entirely — now cached per-device (`statSync(dir).dev`);
 *    (b) the second lock's failure was accepted as proof of exclusion
 *    without checking *why* it failed — any errno counted, not just
 *    EWOULDBLOCK/EAGAIN — now the errno is checked explicitly, since only
 *    that specific failure is actual proof; (c) `fd1` leaked if the second
 *    `openSync` threw (both fds were only closed in a `finally` that never
 *    ran) — now each open is wrapped so both fds always close; (d) the
 *    `.selftest` probe file was left on disk forever — now removed in a
 *    `finally`; (e) a FIXED shared `.selftest` path meant two concurrent
 *    processes probing at once could make one's LEGITIMATE lock collision
 *    look like broken flock — now a unique-per-process, per-call path.
 *
 *    The cross-host NFS case itself — client-local locking that passes a
 *    same-host self-test while a DIFFERENT host acquires independently — is
 *    DOCUMENTED AND ACCEPTED, not chased further: no in-process probe run on
 *    one host can observe another host's lock state, so this is an
 *    unsupportable-by-construction limit of any advisory-lock approach, not
 *    a bug. `GLANCE_STATE_DIR` MUST be a local filesystem; network
 *    filesystems are explicitly unsupported and exclusion there is the
 *    operator's responsibility (see docs/operations.md). The `/proc/mounts`
 *    warning stays as an early, cheap heads-up.
 *
 * 4. (Darwin, new) `loadFlock()` always requested glibc's
 *    `__errno_location`, but libSystem (Darwin/BSD) exposes `__error`
 *    instead — every stale reclaim on macOS failed as "unsupported" even
 *    though flock itself works fine there. Fixed: the errno symbol name is
 *    now platform-branched.
 *
 * ROUND 5 / glance#354 (this fix). A scoped delta-verify's FINAL pass over round 4
 * found four residuals — none a two-owner bug (the fence stays exclusive in every
 * case below); timing/hygiene/docs only:
 *
 * 1. (soft-deadline overshoot) {@link acquireFenceOrThrow}'s deadline was checked
 *    only BEFORE each `flock` attempt, so a `flock(LOCK_EX|LOCK_NB)` call that
 *    itself took long enough (scheduler preemption, a slow FFI dispatch) to
 *    cross the deadline still returned success straight into the critical
 *    section — a boot a few ms later than the promised `handoffMs`, never a
 *    double owner. Fixed: recheck the deadline immediately AFTER a successful
 *    acquire too, releasing and giving up if we're already past budget by
 *    then. Also switched the deadline clock from `Date.now()` (wall clock —
 *    can jump on an NTP/manual adjustment, which could make an already-blown
 *    deadline look not-yet-reached) to `performance.now()` (monotonic), and
 *    unified every deadline comparison in this file on `>=` (this function
 *    used to check `>`, {@link acquireStateLock} already used `>=` —
 *    inconsistent operators made the boundary behavior depend on which call
 *    site you read).
 *
 * 2. (EINTR busy-spin) the EINTR retry path `continue`d with no sleep at all,
 *    so a pathological always-EINTR condition (observed: ~1.7M calls in 51ms)
 *    tight-spun burning CPU until the deadline check finally caught up in
 *    wall-clock terms. Fixed: a small sleep ({@link EINTR_RETRY_MS}) before
 *    retrying — the loop still re-checks the deadline first on every
 *    iteration (round 4 #1's fix is untouched), just no longer at spin speed.
 *
 * 3. (libc-absent recheck→throw TOCTOU, still open) {@link
 *    recheckLiveBeforeUnsupported} closed the INITIAL observation's TOCTOU
 *    (round 4 #2), but the recheck-then-throw pair at each unsupported-error
 *    site in {@link reclaimOrCreate} is itself still a check-then-act: a
 *    scheduler pause between the recheck returning null and the `throw`
 *    statement executing could let a peer reclaim and go live in that exact
 *    window, and the fatal error's "confirmed stale, rm it by hand" advice
 *    would then be stale advice. Inserting yet another recheck only pushes
 *    the same gap one statement later — closing it for real needs an atomic
 *    check-and-act primitive (a lock), which is precisely what's unavailable
 *    on this branch (no working flock/libc at all — the already-degraded
 *    case this error exists for). Left as a documented limit: it's ADVICE,
 *    not action (nothing here mutates the lock; the operator can verify
 *    liveness themselves before running `rm`), so the failure mode is a
 *    possibly-stale recommendation, never a second live owner.
 *
 * 4. (per-device cache staleness across remount / st_dev reuse) {@link
 *    ensureFlockExclusive}'s per-device cache (round 4 #3a) has no expiry, so
 *    a cached 'exclusive' verdict can survive a same-device remount with
 *    different lock semantics, or an `st_dev` value being reused after the
 *    original device was unmounted. Exotic (a live remount mid-run), and full
 *    detection would need continuous `/proc/mounts` polling or mount-event
 *    notifications for what's a rare edge case. Fixed the tractable part: the
 *    cache now expires after {@link FLOCK_CACHE_TTL_MS} and re-probes, so a
 *    stale verdict is bounded in how long it can survive rather than living
 *    forever. The genuinely cross-host/no-notification case remains
 *    documented-not-chased, same posture as the NFS cross-host case in round
 *    4 #3.
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

/** Monotonic clock for every deadline computation/comparison in this file
 * (glance#354 residual 1). `Date.now()` is wall-clock: an NTP adjustment or a
 * manual clock change can jump it backward, which would make an
 * already-exceeded deadline look not-yet-reached and silently extend a wait
 * past `handoffMs`. `performance.now()` (available in Bun/Node) only ever
 * moves forward and is unaffected by wall-clock changes; it does NOT share
 * an epoch with `Date.now()`, so it must be used for BOTH the deadline
 * computation and every comparison against it — never mixed with `Date.now()`.
 * @substrate exported for tests only, so a direct unit test can construct a
 * deadline in the SAME clock basis production code uses (e.g.
 * `monotonicNow() + 100`) rather than mixing in `Date.now()`, which has a
 * different epoch and would make the deadline meaningless. */
export function monotonicNow(): number {
	return performance.now();
}

export interface LockRecord {
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

/** Result of a read-only lock probe: whether a LIVE daemon currently owns `stateDir`, and the
 *  lock record found on disk (whether or not its owner is still alive). `owner` is null only
 *  when no lock file exists at all. */
export interface DaemonLockProbe {
	live: boolean;
	owner: LockRecord | null;
}

/**
 * Read-only: does a LIVE daemon currently hold `stateDir`'s single-writer lock? Uses the SAME
 * check `acquireStateLock` uses to decide whether to block a second daemon (`daemon.lock`'s
 * recorded pid + host, with the Linux `/proc` start-time pin to rule out pid reuse) — but never
 * creates, reclaims, or deletes anything, so it's safe to call from a read-mostly tool (e.g. the
 * receipt-attribution backfill script) that needs to refuse running against a state dir the
 * daemon might be actively writing to, without racing `acquireStateLock`'s own
 * reclaim-a-stale-lock logic.
 *
 * @substrate its only caller is `scripts/backfill-receipt-attribution.ts` (a CLI tool, outside
 * the dead-export scanner's src/+webapp reference universe by design) plus its own test
 * (tests/backfill-receipt-attribution.test.ts, tests/state-lock.test.ts) — a deliberate reuse of
 * `acquireStateLock`'s own liveness/pid-reuse logic rather than a second implementation of it.
 */
export function probeDaemonLock(stateDir: string): DaemonLockProbe {
	const rec = readRecord(lockPath(stateDir));
	if (!rec) return { live: false, owner: null };
	return { live: ownerAlive(rec), owner: rec };
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
 * {@link probeFlockExclusive} catches the SAME-HOST case of this. The
 * CROSS-HOST case (client-local locking that passes a same-host probe while a
 * DIFFERENT host acquires independently) is DOCUMENTED AND ACCEPTED, not
 * chased further (ROUND 4 #3) — no in-process probe run on one host can ever
 * observe another host's lock state, so this is an unsupportable-by-
 * construction limit of any advisory-lock approach, not a bug. `GLANCE_STATE_DIR`
 * MUST be a local filesystem; network filesystems are unsupported and
 * exclusion there is the operator's responsibility. */
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
				`WARNING: ${dirPath} is on a network filesystem (${best.fsType}, mounted at ${best.mountPoint}).\n` +
					`  GLANCE_STATE_DIR MUST be a local filesystem — network filesystems (NFS/SMB/etc.) are ` +
					`UNSUPPORTED for stale-lock reclamation. glance's self-test can catch a SAME-HOST no-op ` +
					`(e.g. NFS with local_lock=flock/all), but it cannot detect the CROSS-HOST case: a ` +
					`same-host probe can pass while a DIFFERENT host still acquires the lock independently — ` +
					`no in-process check can observe another host's lock state. Exclusion on a network ` +
					`filesystem is not guaranteed and is YOUR responsibility. See docs/operations.md.\n`,
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

/** Used only when we give up waiting for the reclaim fence AND the lock file
 * is unreadable/corrupt/absent at that exact moment (ROUND 4 #1) — we know
 * SOMETHING is contending (the fence is genuinely held), we just can't
 * identify it. `pid: -1` is a sentinel, never a real pid. */
function unknownOwnerPlaceholder(): LockRecord {
	return { pid: -1, host: os.hostname(), startedAt: 0 };
}

/**
 * ROUND 4 #2: before ever throwing the fatal "can't reclaim safely, remove it
 * by hand" error, re-check RIGHT NOW whether the lock has gone live — a peer
 * may have reclaimed and installed a live record in the window between the
 * caller's own staleness observation and this point (e.g. immediately after
 * `loadFlock()` returns null, or immediately after the exclusion self-test
 * fails). Never advise manual `rm` against a lock that's live right now.
 * Returns the live owner (take the normal wait/handoff path instead) or null
 * (still genuinely unreclaimable — safe to throw the fatal error).
 *
 * glance#354 residual 3 (still open, libc-absent only): this closes the
 * window BEFORE the recheck, but the recheck-then-throw pair at each call
 * site is itself a check-then-act — a pause between this returning null and
 * the caller's `throw` executing could still let a peer go live in between.
 * That residual gap can't be closed further without an atomic primitive
 * (a lock), which is exactly what's unavailable on the branch this guards
 * (no working flock/libc at all). Accepted: the thrown error is advice
 * ("rm it by hand"), never an action, so the worst case is momentarily-stale
 * advice, not a second live owner.
 * @substrate exported for tests only — `reclaimOrCreate` (same file) is the
 * one production caller, at both unsupported-error throw sites.
 */
export function recheckLiveBeforeUnsupported(file: string): { owner: LockRecord } | null {
	const current = readRecord(file);
	if (current && ownerAlive(current)) return { owner: current };
	return null;
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

/** Binds `flock` + the platform's errno accessor from one dlopen'd library, or
 * null if either symbol is missing. ROUND 4 #4: libSystem (Darwin/BSD)
 * exposes `__error`, not glibc/musl's `__errno_location` — binding the wrong
 * name for the platform silently loaded (dlopen doesn't validate unused
 * symbols eagerly the same way) but crashed or misbehaved on first real use,
 * so this is platform-branched explicitly rather than guessed. */
function dlopenLibc(name: string): Flock | null {
	try {
		if (process.platform === "darwin") {
			const lib = dlopen(name, {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				__error: { args: [], returns: FFIType.ptr },
			});
			return {
				lock: (fd, op) => lib.symbols.flock(fd, op),
				errno: () => {
					const errnoPtr = lib.symbols.__error();
					if (!errnoPtr) throw new Error("__error returned null");
					return read.i32(errnoPtr, 0);
				},
			};
		}
		const lib = dlopen(name, {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			__errno_location: { args: [], returns: FFIType.ptr },
		});
		return {
			lock: (fd, op) => lib.symbols.flock(fd, op),
			errno: () => {
				const errnoPtr = lib.symbols.__errno_location();
				if (!errnoPtr) throw new Error("__errno_location returned null");
				return read.i32(errnoPtr, 0);
			},
		};
	} catch {
		return null;
	}
}

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
		const bound = dlopenLibc(name);
		if (bound) {
			flock = bound;
			return flock;
		}
	}
	flock = null;
	return null;
}

/**
 * ROUND 3 #3/#5, hardened in ROUND 4 #3: does flock actually provide mutual
 * exclusion for `testPath` on whatever filesystem it lives on? Opens it TWICE
 * in this process and confirms the second `LOCK_EX|LOCK_NB` fails with
 * SPECIFICALLY EWOULDBLOCK/EAGAIN (ROUND 4 #3b — any OTHER errno is
 * inconclusive, not proof of exclusion). Some mounts (NFS with
 * `local_lock=flock`/`all`, or other misconfigured network filesystems) make
 * flock a client-local no-op — both "acquire" it and the original
 * double-owner race returns silently. Both fds are guaranteed closed even if
 * the second `openSync` throws (ROUND 4 #3c — `fd1` used to leak in that
 * case). Exported so it can be unit-tested directly against both the real
 * flock (expect true) and a deliberately no-op stub (expect false) — a
 * regression here must fail the suite even if the slower multi-process race
 * test doesn't happen to reproduce it.
 * @substrate exported for tests only — `ensureFlockExclusive` (same file) is
 * the one production caller; `tests/state-lock.test.ts` is the only
 * out-of-file caller, asserting this function directly against both a real
 * and a stubbed flock (ROUND 3 #5 — the suite must fail if this regresses).
 */
export function probeFlockExclusive(f: Flock, testPath: string): boolean {
	const fd1 = openSync(testPath, "a+");
	try {
		const fd2 = openSync(testPath, "a+");
		try {
			if (f.lock(fd1, LOCK_EX | LOCK_NB) !== 0) return false; // couldn't even get the first — inconclusive, treat as unusable
			try {
				if (f.lock(fd2, LOCK_EX | LOCK_NB) === 0) {
					f.lock(fd2, LOCK_UN); // it "succeeded" — not exclusive; release before reporting failure
					return false;
				}
				// Only a genuine EWOULDBLOCK/EAGAIN counts as proof of exclusion — any
				// OTHER errno (EBADF, EINVAL, a transient failure, ...) is inconclusive,
				// not evidence flock actually excludes here (ROUND 4 #3b).
				return f.errno() === EWOULDBLOCK;
			} finally {
				f.lock(fd1, LOCK_UN);
			}
		} finally {
			closeSync(fd2);
		}
	} finally {
		closeSync(fd1); // always closes, even if the second openSync above threw (ROUND 4 #3c)
	}
}

/** Cached PER FILESYSTEM DEVICE (ROUND 4 #3a), not one global boolean — a
 * local-disk success must never make a LATER state dir on a different (and
 * possibly genuinely non-exclusive) mount skip probing entirely. */
const flockExclusiveByDevice = new Map<number, { result: boolean; checkedAt: number }>();

/** How long a per-device exclusivity verdict is trusted before being
 * re-probed (glance#354 residual 4): without an expiry, a cached 'exclusive'
 * verdict can survive a same-device remount with different lock semantics
 * (a remount typically keeps the same `st_dev`, so the cache key alone
 * doesn't change) or an `st_dev` value being reused after the original
 * device was unmounted. Genuine mount-change detection would need
 * continuous `/proc/mounts` polling (or mount-namespace notifications) for
 * what's an exotic edge case in practice — a bounded TTL instead trades a
 * small amount of re-probing for an upper bound on how long a stale verdict
 * can survive.
 * @substrate exported for tests only, so a TTL-expiry test can assert
 * against the real value rather than a hardcoded duplicate. */
export const FLOCK_CACHE_TTL_MS = 5 * 60_000;

/** @substrate exported for tests only — `reclaimOrCreate` (same file) is the
 * one production caller; `tests/state-lock.test.ts` calls this directly
 * against paths on two genuinely different real devices (`/tmp` and
 * `/dev/shm`, both root-free) to prove the cache is keyed per-device and not
 * one global flag (ROUND 4 #3a), and against one device across a simulated
 * TTL expiry (via the `now` param) to prove a stale verdict doesn't survive
 * forever (glance#354 residual 4).
 * @param now Clock reading to evaluate the cache's freshness against.
 * Defaults to {@link monotonicNow}; overridable so a test can simulate TTL
 * expiry deterministically without sleeping the real 5 minutes. */
export function ensureFlockExclusive(f: Flock, fenceFile: string, now: number = monotonicNow()): boolean {
	let dev: number;
	try {
		dev = statSync(path.dirname(fenceFile)).dev;
	} catch {
		dev = -1; // can't stat the dir (astonishingly unlikely) — shared fallback bucket, still correct, just not device-specific
	}
	const cached = flockExclusiveByDevice.get(dev);
	if (cached !== undefined && now - cached.checkedAt < FLOCK_CACHE_TTL_MS) return cached.result;
	// A DEDICATED, UNIQUE-per-process-per-call path, never the live fence file
	// and never a fixed shared name: the fence can be legitimately held by
	// another racer at any moment (that's the whole point of it), and a fixed
	// shared `.selftest` path could ALSO be probed by another process at the
	// same instant — either way, a probe's first lock attempt failing because
	// of real, unrelated contention is not evidence flock is broken; it would
	// misclassify an ordinary collision as "unsupported" (ROUND 4 #3e). A
	// sibling path on the same directory (same device) is representative of
	// the same filesystem's flock behavior without ever colliding with
	// anyone else's traffic.
	const probePath = `${fenceFile}.selftest.${process.pid}.${Math.random().toString(36).slice(2)}`;
	let result: boolean;
	try {
		result = probeFlockExclusive(f, probePath);
	} finally {
		try {
			unlinkSync(probePath); // never leave the probe file behind (ROUND 4 #3d)
		} catch {
			// Best-effort — the path is unique, so a leftover is harmless either way.
		}
	}
	flockExclusiveByDevice.set(dev, { result, checkedAt: now });
	return result;
}

type ReclaimOutcome = { kind: "created" } | { kind: "retry" } | { kind: "live"; owner: LockRecord };

const RECLAIM_POLL_MS = 20;
/** Small sleep before retrying an EINTR'd `flock` attempt (glance#354 residual
 * 2). Retrying immediately made a pathological always-EINTR condition
 * tight-spin (observed: ~1.7M calls in 51ms) instead of yielding — the
 * deadline check at the top of the loop is still hit every iteration (round
 * 4 #1's fix is unaffected), this just stops the loop from burning CPU at
 * spin speed while it does. */
const EINTR_RETRY_MS = 1;

/**
 * ROUND 3 #1, hardened in ROUND 4 #1: acquire the fence non-blockingly
 * (`LOCK_EX|LOCK_NB`), retried against a HARD `deadline` ceiling checked
 * FIRST on every loop iteration — before the flock attempt, before ANY retry
 * path (EWOULDBLOCK, EINTR). One check governs every exit: once we're past
 * budget we throw {@link StateLockError} immediately and NEVER attempt to
 * enter the critical section, no matter which retry path got us there (a
 * stuck/STOPPED holder, a corrupt-or-unreadable lock record at give-up time,
 * or a storm of EINTR retries that would otherwise `continue` straight past
 * the check). Never a blocking `LOCK_EX`, which would let a STOPPED or
 * wedged holder block every future boot forever with no bound.
 * @substrate exported for tests only — `reclaimOrCreate` (same file) is the
 * one production caller; `tests/state-lock.test.ts` unit-tests this directly
 * against a fake always-EINTR `Flock` stub to prove an EINTR storm is bounded
 * (ROUND 4 #1) without needing to engineer a real signal-interrupted syscall.
 */
export async function acquireFenceOrThrow(f: Flock, fd: number, file: string, fenceFile: string, deadline: number): Promise<void> {
	for (;;) {
		if (monotonicNow() >= deadline) {
			// Someone (or something stuck/stopped) has held the fence past our
			// whole budget, or a storm of retries burned it. We never entered the
			// critical section, so we can't have stomped anything — give up and
			// report the most current view (falling back to a placeholder if the
			// lock file is itself unreadable/corrupt/absent right now — we still
			// know SOMETHING is contending, even if we can't identify it).
			const current = readRecord(file);
			throw new StateLockError(file, current ?? unknownOwnerPlaceholder());
		}
		const ret = f.lock(fd, LOCK_EX | LOCK_NB);
		if (ret === 0) {
			// glance#354 residual 1: the check above ran BEFORE this attempt, so a
			// `flock` call that itself took long enough (scheduler preemption, a
			// slow FFI dispatch) to cross the deadline used to return success
			// straight into the critical section a little past budget — not a
			// two-owner bug (the fence is still exclusive either way), just a
			// boot that quietly overshoots `handoffMs`. Recheck immediately AFTER
			// a successful acquire and give up cleanly (releasing what we just
			// took) rather than proceed late and silently.
			if (monotonicNow() >= deadline) {
				f.lock(fd, LOCK_UN);
				const current = readRecord(file);
				throw new StateLockError(file, current ?? unknownOwnerPlaceholder());
			}
			return; // acquired, within budget
		}
		const errno = f.errno();
		if (errno === EINTR) {
			// glance#354 residual 2: a small sleep bounds an always-EINTR
			// condition to a sane retry rate instead of a tight spin. The
			// deadline is still re-checked FIRST on the next iteration — this
			// sleep never bypasses it, it just stops burning CPU while waiting
			// to hit it.
			await Bun.sleep(EINTR_RETRY_MS);
			continue;
		}
		if (errno !== EWOULDBLOCK) throw new Error(`flock(LOCK_EX|LOCK_NB) on ${fenceFile} failed with errno ${errno}`);
		await Bun.sleep(RECLAIM_POLL_MS);
	}
}

/**
 * Reclaim-and-create, holding a real kernel advisory lock (flock) for the
 * whole decide-and-act section (see the ROUND 2/3 notes in the module
 * docstring). Only one process anywhere can be inside the critical section at
 * a time for a given `file` — the kernel enforces it and releases it the
 * instant a holder exits, by any means, with no timeout and no steal.
 *
 * Throws {@link StateLockError} if the fence can't be acquired within budget
 * (see {@link acquireFenceOrThrow}), or {@link StateLockReclaimUnsupportedError}
 * if no advisory lock is available or one loaded but failed
 * {@link probeFlockExclusive} — in both unsupported cases, RE-CHECKING first
 * (ROUND 4 #2, {@link recheckLiveBeforeUnsupported}) whether the lock has
 * gone live in the meantime, since the fatal error's advice ("remove it by
 * hand") must never be given against a lock that's live right now.
 */
async function reclaimOrCreate(file: string, deadline: number): Promise<ReclaimOutcome> {
	const f = loadFlock();
	if (!f) {
		const live = recheckLiveBeforeUnsupported(file);
		if (live) return { kind: "live", owner: live.owner };
		// glance#354 residual 3 (libc-absent only — this branch only runs when
		// there's no working flock/libc at all, an already-degraded state): the
		// recheck above closes round 4 #2's window, but recheck-then-throw is
		// ITSELF a check-then-act pair — a scheduler pause right here, between
		// the recheck returning null and this throw executing, could still let
		// a peer reclaim and go live before the error is actually thrown.
		// Inserting another recheck only moves the same gap one statement
		// later; closing it for real needs an atomic check-and-throw
		// primitive, which requires exactly the kernel lock this branch
		// doesn't have. Left as a documented limit rather than chased further:
		// the thrown error is ADVICE ("rm it by hand"), not an action — nothing
		// here mutates the lock — so the worst case is a momentarily-stale
		// recommendation an operator can verify before acting on, never a
		// second live owner.
		throw new StateLockReclaimUnsupportedError(file, "no-flock");
	}

	cleanupRound1Debris(file);
	const fenceFile = reclaimFencePath(file);
	if (!ensureFlockExclusive(f, fenceFile)) {
		const live = recheckLiveBeforeUnsupported(file);
		if (live) return { kind: "live", owner: live.owner };
		// Same residual-3 limit as above, at the other unsupported-error site.
		throw new StateLockReclaimUnsupportedError(file, "flock-not-exclusive");
	}

	const fd = openSync(fenceFile, "a+"); // create if missing; content is never used
	try {
		await acquireFenceOrThrow(f, fd, file, fenceFile, deadline);
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
	const deadline = monotonicNow() + (opts.handoffMs ?? HANDOFF_TIMEOUT_MS);

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
			if (monotonicNow() >= deadline) throw new StateLockError(file, observed);
			await Bun.sleep(HANDOFF_POLL_MS);
			continue;
		}

		// reclaimOrCreate throws directly (ROUND 4 #1) if the fence itself can't
		// be acquired within budget — it never returns here on a timeout, so a
		// "live" outcome below is always a genuine, just-observed peer (either it
		// legitimately won the reclaim, or ROUND 4 #2's re-check caught the lock
		// going live around an unsupported-reclaim throw).
		const outcome = await reclaimOrCreate(file, deadline);
		if (outcome.kind === "created") break;
		if (outcome.kind === "retry") continue;

		// A genuinely live peer holds it. During upgrade the outgoing daemon dies
		// within the handoff window; a genuine double-start never will, so we
		// eventually throw.
		if (monotonicNow() >= deadline) throw new StateLockError(file, outcome.owner);
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
