/**
 * Race fixture for the state-lock TOCTOU test. Spawned concurrently many times
 * against one state dir. Each child acquires the lock, then reads the lock file
 * back and asserts it holds OUR record. Under the old openSync(wx)+writeSync
 * acquire, a racing child could unlink a just-created (still-empty) lock and
 * write its own — leaving an earlier "winner" holding a lock file that contains
 * someone else's pid. That mismatch is the bug; here it surfaces as exit code 3.
 */

import { readFileSync } from "node:fs";
import { acquireStateLock } from "../../src/state-lock.ts";

const dir = process.argv[2];

const lock = await acquireStateLock(dir, { handoffMs: 50 }).catch(() => null);
if (!lock) process.exit(0); // a live owner held it — legitimate refusal, not a bug

// Hold briefly so concurrent children genuinely overlap on the create/write window.
await Bun.sleep(20);
const rec = JSON.parse(readFileSync(lock.file, "utf8")) as { pid: number };
if (rec.pid !== process.pid) process.exit(3); // we "own" a lock file that isn't ours
lock.release();
process.exit(0);
