# Durability across an UNCLEAN stop
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: tests/persist-durability.test.ts, scripts/durability-archil.ts
BLOCKED_BY: 01
PLANE: OMPSQ-76 — https://app.plane.so/inkwell-finance/browse/OMPSQ-76/

## Goal

Prove the property the whole Archil case rests on: a host crash keeps *committed* work. A clean unmount
flushes, so a clean mount→remount cycle is a **false green** — it passes precisely because it never exercises
the no-fsync window. The test must crash the writer with NO clean shutdown, then assert survival. This matters
*more* under the collaborative-substrate framing (more concurrent writers = more crash exposure), not less.

**Local crash-survival is engineering-ready** (validates concern 01's fsync). The **real-Archil remount** leg
needs a human-provisioned disk + `ARCHIL_*` (external-dep).

## Approach

Two artifacts:

1. **`tests/persist-durability.test.ts` (local, engineering-ready, the runnable check for 01+03):**
   - Spawn a tiny writer subprocess (Bun) that: writes a real `state.json` via the hardened
     `writeFileDurable` (concern 01) + a `transcripts.json` + appends a receipts NDJSON line, all under a
     tmp dir, `fsync`s, prints `COMMITTED` to stdout, then loops/sleeps.
   - Parent waits for `COMMITTED`, then `process.kill(pid, "SIGKILL")` — an **unclean** stop (no
     `manager.stop()`, no flush hook).
   - Re-read the files from the parent and assert: `state.json` parses and contains the committed agents;
     the receipts tail is intact (or tolerably truncated per receipts.ts:173-184, never corrupt mid-record);
     no stray `.tmp` masquerading as truth.
   - **Negative control:** a variant writer that uses a NON-fsync write (plain `writeFile`) — assert the test
     harness *can* observe loss there (so the test proves fsync is what saves it, not luck). `ponytail:` if
     the local FS buffers make non-fsync loss unobservable without a real power cut, assert instead that the
     fsync path is on the commit (spy) and document that true loss needs the Archil leg below.

2. **`scripts/durability-archil.ts` (live, external-dep):** write the same fileset + a real git worktree onto
   an Archil mount, `fsync`, `kill -9` the writer (NOT `archil unmount`), then **remount** the disk and assert
   the committed `state.json`/transcripts/worktree survived the crash-without-clean-unmount. This is the leg
   that exercises Archil's "fsync = durable across AZs, even if the client dies before async S3 sync" claim.
   If `ARCHIL_*` unset → exit reporting the creds blocker; do not skip silently and do not fake a pass.

## Cross-Repo Side Effects
None. Read-only against `src/dal/store.ts` (uses the helper 01 adds). Throwaway script + one test.

## Verify
- `bun test tests/persist-durability.test.ts` green: after a `SIGKILL` of the writer, the last committed
  persist is readable and uncorrupted; the negative control behaves as documented.
- Live: `bun scripts/durability-archil.ts` against a provisioned disk shows the committed state surviving a
  `kill -9` + remount; otherwise reports the creds blocker.
- Gate: `bun run check` + `bun test`. **VERIFY_BLOCKER for the dependency on 01:**
  `grep -n "fh.sync\|writeFileDurable" src/dal/store.ts` returns a hit before starting.
