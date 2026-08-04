/**
 * Child process for the backfill "lock is genuinely HELD" test (round 3 Finding 6,
 * tests/backfill-receipt-attribution.test.ts). Attempts a real `acquireStateLock` against the
 * given state dir with no handoff wait; exits 0 if it acquired (and releases immediately), exits
 * 1 if a live owner blocked it (`StateLockError`).
 *
 * MUST run as a separate process (not an in-process call from the test): `acquireStateLock`'s own
 * reuse-detection (`ownerAlive` in src/state-lock.ts) treats a lock record whose pid equals the
 * CALLER's `process.pid` as "our own stale record from a previous incarnation" and reclaims it —
 * an in-process second acquire attempt from the same `bun test` process would always "succeed" by
 * reclaiming its own lock, which would defeat the whole point of this probe (proving a GENUINELY
 * different acquirer is blocked while `runBackfill` holds the lock).
 */
import { acquireStateLock, StateLockError } from "../../src/state-lock.ts";

const dir = process.argv[2];

try {
	const lock = await acquireStateLock(dir, { handoffMs: 0 });
	lock.release();
	process.exit(0);
} catch (err) {
	if (err instanceof StateLockError) process.exit(1);
	console.error(err);
	process.exit(2);
}
