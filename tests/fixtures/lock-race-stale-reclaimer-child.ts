/**
 * Race fixture for the stale-reclamation TOCTOU (lmvdz/glance#345). Spawned
 * concurrently (many at once) against ONE state dir seeded with a stale lock
 * (dead pid). The bug: a reclaimer's authorization to unlink the stale lock it
 * observed outlives that lock — it can go on to unlink a SUCCESSOR's freshly
 * created live lock instead, and both racers end up believing they own the dir.
 *
 * No artificial delay is used here — the fix (a real kernel advisory lock,
 * flock, held for the whole decide-and-act section) makes the outcome
 * deterministic regardless of scheduling, so adversarial real-process racing
 * is enough on its own (unlike the pre-fix code, which needed a widened
 * window or enough concurrent racers to reliably interleave).
 *
 * Critically, a winner HOLDS its lock for a while before releasing (rather
 * than exiting immediately) — otherwise its own `process.once("exit",
 * release)` handler unlinks its lock a moment later, and a second acquire
 * after that is legitimate SEQUENTIAL ownership, not the bug. `HOLD_MS` must
 * comfortably outlast every loser's entire wait-then-timeout budget
 * (`HANDOFF_MS`), so a loser's outcome is settled while the winner is
 * provably still alive and still holding — that's what makes "more than one
 * exit 0" mean genuine CONCURRENT double ownership, not one racer legitimately
 * following another.
 *
 * Exit code communicates outcome to the parent test:
 *   0 = acquireStateLock resolved (this child believes it owns the dir)
 *   1 = correctly refused with StateLockError (a live owner, real or a peer
 *       that legitimately won the race, already holds it)
 *   2 = anything else (surfaced via inherited stderr) — a real bug, not a
 *       clean win/lose outcome, so the test must not treat it as a "loss"
 */

import { acquireStateLock, StateLockError } from "../../src/state-lock.ts";

const dir = process.argv[2];
const HANDOFF_MS = 1_000;
const HOLD_MS = 1_800; // well past HANDOFF_MS, so a loser's outcome is settled while we're still alive

try {
	const lock = await acquireStateLock(dir, { handoffMs: HANDOFF_MS });
	// Hold well past every peer's entire wait-then-timeout window, so if a peer
	// wrongly reclaims us it does so while we are provably still alive — the
	// exact shape of "both D1 and D2 now believe they own the state directory."
	await Bun.sleep(HOLD_MS);
	lock.release();
	process.exit(0); // this child believes it owns the state dir
} catch (err) {
	if (err instanceof StateLockError) process.exit(1); // correctly refused / backed off — not a bug
	process.stderr.write(`unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(2);
}
