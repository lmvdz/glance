/**
 * Branch-keyed auto-land failure ledger (src/land-ledger.ts) — the restart-safe retry cap.
 * Covers bump-on-failure, clear-on-success, the undefined-branch no-op, and on-disk persistence
 * (the whole point: the streak survives a daemon restart, keyed by branch not the re-minted agent id).
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landFailureCount, readLandLedger, recordLandOutcome } from "../src/land-ledger.ts";

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "ledger-"));
}

test("a failure bumps the streak, a success clears it", async () => {
	const dir = await tmpDir();
	expect(landFailureCount(dir, "squad/x")).toBe(0);
	expect(recordLandOutcome(dir, "squad/x", false, "gate red")).toBe(1);
	expect(recordLandOutcome(dir, "squad/x", false, "gate red again")).toBe(2);
	expect(landFailureCount(dir, "squad/x")).toBe(2);
	expect(recordLandOutcome(dir, "squad/x", true, "merged")).toBe(0);
	expect(landFailureCount(dir, "squad/x")).toBe(0);
});

test("streaks are per-branch and the latest detail is retained (truncated)", async () => {
	const dir = await tmpDir();
	recordLandOutcome(dir, "squad/a", false, "a failed");
	recordLandOutcome(dir, "squad/b", false, "b failed once");
	recordLandOutcome(dir, "squad/b", false, "b".repeat(900));
	const ledger = readLandLedger(dir);
	expect(ledger["squad/a"].fails).toBe(1);
	expect(ledger["squad/b"].fails).toBe(2);
	expect(ledger["squad/b"].lastDetail.length).toBe(600); // capped
});

test("an undefined branch is a no-op (never keys the ledger)", async () => {
	const dir = await tmpDir();
	expect(recordLandOutcome(dir, undefined, false, "x")).toBe(0);
	expect(readLandLedger(dir)).toEqual({});
});

test("the streak persists on disk (survives a 'restart' — a fresh read of the same dir)", async () => {
	const dir = await tmpDir();
	recordLandOutcome(dir, "squad/x", false, "1");
	recordLandOutcome(dir, "squad/x", false, "2");
	recordLandOutcome(dir, "squad/x", false, "3");
	// Simulate a restart: nothing in memory, only the file on disk.
	expect(landFailureCount(dir, "squad/x")).toBe(3);
});

test("a missing/corrupt ledger reads as empty, never throws", async () => {
	const dir = await tmpDir();
	expect(readLandLedger(dir)).toEqual({});
	await fs.writeFile(path.join(dir, "land-failures.json"), "{not json");
	expect(readLandLedger(dir)).toEqual({});
});
