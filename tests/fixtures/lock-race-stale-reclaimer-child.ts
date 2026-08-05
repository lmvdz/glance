/**
 * Race fixture for the stale-reclamation TOCTOU (lmvdz/glance#345). Spawned
 * concurrently (exactly two) against ONE state dir seeded with a stale lock
 * (dead pid). The bug: a reclaimer's authorization to unlink the stale lock it
 * observed outlives that lock — it can go on to unlink a SUCCESSOR's freshly
 * created live lock instead, and both racers end up believing they own the dir.
 *
 * `testOnlyReclaimDelayMs` widens the window between "I decided this lock is
 * stale" and "I unlink it" so both children are guaranteed to have made that
 * determination before either acts — forcing the exact interleaving from the
 * gauntlet finding instead of hoping for sub-millisecond scheduling luck.
 *
 * Critically, a winner HOLDS its lock for a while before releasing (rather than
 * exiting immediately) — otherwise its own `process.once("exit", release)`
 * handler unlinks its lock a moment later, and a second acquire after that is
 * legitimate SEQUENTIAL ownership, not the bug. `holdMs` must comfortably
 * outlast the loser's entire wait-then-timeout budget (`handoffMs`) so the
 * loser's success/failure is decided while the winner is provably still alive
 * and still holding — that's what makes an "owners === 2" result mean genuine
 * CONCURRENT double ownership, not one racer legitimately following another.
 *
 * Exit code communicates outcome to the parent test:
 *   0 = acquireStateLock resolved (this child believes it owns the dir)
 *   1 = acquireStateLock rejected (this child correctly backed off)
 */

import { acquireStateLock } from "../../src/state-lock.ts";

const dir = process.argv[2];
const delayMs = Number(process.argv[3]);
const HANDOFF_MS = 1_000;
const HOLD_MS = 1_800; // well past HANDOFF_MS, so a loser's outcome is settled while we're still alive

const lock = await acquireStateLock(dir, { handoffMs: HANDOFF_MS, testOnlyReclaimDelayMs: delayMs }).catch(() => null);
if (!lock) process.exit(1); // correctly refused / backed off — not a bug

// Hold well past the peer's entire wait-then-timeout window, so if the peer
// wrongly reclaims us it does so while we are provably still alive — the
// exact shape of "both D1 and D2 now believe they own the state directory."
await Bun.sleep(HOLD_MS);
lock.release();
process.exit(0); // this child believes it owns the state dir
