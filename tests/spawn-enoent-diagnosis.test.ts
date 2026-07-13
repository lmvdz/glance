/**
 * `posix_spawn` returns ENOENT for a missing EXECUTABLE and for a missing WORKING DIRECTORY, and Bun's
 * error text names the executable either way.
 *
 * Live incident: a unit's worktree was gone by the time its host spawned, and the daemon recorded
 *
 *     ENOENT: no such file or directory, posix_spawn '/…/volta/…/bun/bin/bun.exe'
 *
 * — naming a 92 MB binary that plainly exists, and which the daemon itself was executing at that moment.
 * The operator's reasonable next question was "why are we running bun.exe under WSL?", which is a dead end:
 * the `.exe` is Volta's filename for a Linux ELF. The real cause, the cwd, appeared nowhere. Worse,
 * `create()`'s failed-start cleanup removes the worktree, so by the time anyone looks the evidence is gone.
 *
 * Verified against the real Bun (1.3.14) before writing this: spawning an existing executable with a
 * nonexistent cwd produces exactly that message, naming the executable.
 */

import { expect, test } from "bun:test";
import { diagnoseSpawnFailure } from "../src/rpc-agent.ts";

const ENOENT = (exe: string) => new Error(`ENOENT: no such file or directory, posix_spawn '${exe}'`);
const REAL_EXE = process.execPath; // exists, by definition
const REAL_DIR = "/tmp";

test("a missing cwd is named as the cause, and the executable is exonerated", () => {
  const msg = diagnoseSpawnFailure(ENOENT(REAL_EXE), REAL_EXE, "/definitely/not/here");
  expect(msg).toContain("the working directory does not exist");
  expect(msg).toContain("/definitely/not/here");
  expect(msg).toContain("is present"); // says so about the executable, so nobody chases it
});

test("a missing executable is named as the cause", () => {
  const msg = diagnoseSpawnFailure(ENOENT("/no/such/bun"), "/no/such/bun", REAL_DIR);
  expect(msg).toContain("the executable does not exist");
  expect(msg).toContain("/no/such/bun");
  expect(msg).not.toContain("working directory does not exist");
});

test("both missing says both", () => {
  const msg = diagnoseSpawnFailure(ENOENT("/no/such/bun"), "/no/such/bun", "/nor/this");
  expect(msg).toContain("neither");
});

/** The honest case. Both paths exist NOW, so the cwd was probably removed between the check and the
 *  spawn — say what was verified and name the suspicion; never assert a cause we did not observe. */
test("when both exist, it reports a race rather than inventing a culprit", () => {
  const msg = diagnoseSpawnFailure(ENOENT(REAL_EXE), REAL_EXE, REAL_DIR);
  expect(msg).toContain("removed concurrently");
  expect(msg).toContain("ENOENT"); // the original text survives
});

/** Not every spawn failure is ENOENT. EACCES, ENOMEM, and friends must pass through untouched. */
test("a non-ENOENT failure is passed through verbatim", () => {
  expect(diagnoseSpawnFailure(new Error("EACCES: permission denied"), REAL_EXE, REAL_DIR)).toBe("EACCES: permission denied");
});
