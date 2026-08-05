/**
 * Simulates a reclaimer STOPPED or wedged in a stuck syscall while holding the
 * reclaim fence (lmvdz/glance#345, ROUND 3 #1). Acquires the real flock on the
 * fence file for `daemon.lock` under `dir`, signals readiness by writing a
 * "ready" file, then holds the flock for `HOLD_MS` — far longer than any
 * acquirer's `handoffMs` — before releasing. If a blocking `flock(LOCK_EX)`
 * were still used elsewhere, an acquirer racing against this holder would
 * block for the full `HOLD_MS` (or forever, for a truly wedged process); with
 * the bounded `LOCK_EX|LOCK_NB` retry, an acquirer must give up well before
 * `HOLD_MS` elapses.
 */
import { openSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadFlock, reclaimFencePath } from "../../src/state-lock.ts";

const LOCK_EX = 2;
const LOCK_UN = 8;
const HOLD_MS = 4_000;

const dir = process.argv[2];
const readyFile = process.argv[3];

const file = path.join(dir, "daemon.lock");
const fenceFile = reclaimFencePath(file);
const flock = loadFlock();
if (!flock) {
	process.stderr.write("no flock available on this platform — fixture cannot simulate a wedged holder\n");
	process.exit(2);
}

const fd = openSync(fenceFile, "a+");
const ret = flock.lock(fd, LOCK_EX); // blocking — this fixture is real (not a stub), just held for a while
if (ret !== 0) {
	process.stderr.write(`failed to acquire the fence: ${ret}\n`);
	process.exit(2);
}
writeFileSync(readyFile, "ready");
await Bun.sleep(HOLD_MS);
flock.lock(fd, LOCK_UN);
process.exit(0);
