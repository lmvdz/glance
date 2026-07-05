/**
 * Branch-keyed auto-land failure ledger (src/land-ledger.ts) — the restart-safe retry cap.
 * Covers bump-on-failure, clear-on-success, the undefined-branch no-op, and on-disk persistence
 * (the whole point: the streak survives a daemon restart, keyed by branch not the re-minted agent id).
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landFailureCount, readForcedLands, readLandLedger, readValidatorOverrides, recordForcedLand, recordLandOutcome, recordValidatorOverride } from "../src/land-ledger.ts";

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

test("recordForcedLand appends an audit record (actor + detail + timestamp), oldest first", async () => {
	const dir = await tmpDir();
	expect(readForcedLands(dir)).toEqual([]);
	expect(recordForcedLand(dir, "squad/x", "operator@local", "no proof — forced", 1000)).toBe(1);
	expect(recordForcedLand(dir, "squad/y", "ci-bot", "b".repeat(900), 2000)).toBe(2);
	const list = readForcedLands(dir);
	expect(list.length).toBe(2);
	expect(list[0]).toEqual({ branch: "squad/x", actor: "operator@local", detail: "no proof — forced", at: 1000 });
	expect(list[1].actor).toBe("ci-bot");
	expect(list[1].detail.length).toBe(600); // capped
});

test("recordForcedLand is a no-op for an undefined branch and survives a corrupt file", async () => {
	const dir = await tmpDir();
	expect(recordForcedLand(dir, undefined, "x", "y")).toBe(0);
	expect(readForcedLands(dir)).toEqual([]);
	await fs.writeFile(path.join(dir, "land-forced.json"), "{not json");
	expect(readForcedLands(dir)).toEqual([]); // corrupt ⇒ empty, never throws
	expect(recordForcedLand(dir, "squad/z", "a", "b", 5)).toBe(1); // and recovers
});

// ── Validator-override (Epic 3, leaf 03) — a strictly stronger, SEPARATE override class ───────────

test("recordValidatorOverride with a non-empty reasonClass writes and round-trips via readValidatorOverrides", async () => {
	const dir = await tmpDir();
	expect(readValidatorOverrides(dir)).toEqual([]);
	expect(recordValidatorOverride(dir, "squad/x", "operator@local", "judge-hallucination", "the judge misread the diff", 1000)).toBe(1);
	const list = readValidatorOverrides(dir);
	expect(list.length).toBe(1);
	expect(list[0]).toEqual({ branch: "squad/x", actor: "operator@local", reasonClass: "judge-hallucination", detail: "the judge misread the diff", at: 1000 });
});

test("an empty (or whitespace-only) reasonClass is a no-op — the veto stands, nothing is written", async () => {
	const dir = await tmpDir();
	expect(recordValidatorOverride(dir, "squad/x", "a", "", "detail")).toBe(0);
	expect(recordValidatorOverride(dir, "squad/x", "a", "   ", "detail")).toBe(0);
	expect(readValidatorOverrides(dir)).toEqual([]);
});

test("recordValidatorOverride is a no-op for an undefined branch and never touches the proof-force ledger", async () => {
	const dir = await tmpDir();
	recordForcedLand(dir, "squad/a", "actor", "force detail", 1);
	expect(recordValidatorOverride(dir, undefined, "x", "reason", "y")).toBe(0);
	recordValidatorOverride(dir, "squad/b", "actor", "emergency", "bypass", 2);
	// The proof-force ledger is completely untouched by an override write.
	expect(readForcedLands(dir)).toEqual([{ branch: "squad/a", actor: "actor", detail: "force detail", at: 1 }]);
	expect(readValidatorOverrides(dir)).toEqual([{ branch: "squad/b", actor: "actor", reasonClass: "emergency", detail: "bypass", at: 2 }]);
});

test("readValidatorOverrides survives a corrupt file", async () => {
	const dir = await tmpDir();
	await fs.writeFile(path.join(dir, "land-validator-override.json"), "{not json");
	expect(readValidatorOverrides(dir)).toEqual([]);
	expect(recordValidatorOverride(dir, "squad/z", "a", "criteria-wrong", "b", 5)).toBe(1); // and recovers
});
