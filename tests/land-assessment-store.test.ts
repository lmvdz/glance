/**
 * Concern 07 (event-store-writer) verification: concurrent-append stress yields zero torn lines and
 * correct seq ordering; CRC detects an artificially truncated line; dedup drops an identical
 * re-append (and preserves, rather than throws on, a same-key/different-hash nondeterminism); a
 * failing underlying write surfaces telemetry without throwing to the caller.
 *
 * Lives in `tests/`, not co-located under `src/land-assessment/` (the concern doc's literal TOUCHES
 * path) — same convention as concerns 01-04 (`bunfig.toml`'s `[test] root = "tests"`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutomationEvent } from "../src/automation-log.ts";
import { LocalStorageBackend, setStorageBackend, type StorageBackend } from "../src/dal/storage.ts";
import {
	__resetShardStateForTests,
	appendLandAssessmentSnapshot,
	appendLandAttemptEvent,
	formatStoredLine,
	parseStoredLine,
	repoHash16,
	type StoredRecordEnvelope,
} from "../src/land-assessment/store.ts";
import { SCHEMA_VERSION, type AnalysisEnvironmentFingerprint, type LandAssessmentSnapshot, type LandAttemptEvent, type RepositoryStateRef } from "../src/land-assessment/schema.ts";

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────────────

const stateRef = (commit: string, repositoryId = "repo-a"): RepositoryStateRef => ({ repositoryId, commit, tree: `tree-${commit}` });

const environment: AnalysisEnvironmentFingerprint = {
	analyzerName: "typescript-structural-delta",
	analyzerVersion: "0.1.0",
	language: "typescript",
	mode: "syntax-only",
	configurationHash: "cfg-1",
};

function baseEvent(overrides: Partial<LandAttemptEvent> = {}): LandAttemptEvent {
	return {
		schemaVersion: SCHEMA_VERSION,
		eventId: "event-1",
		attemptId: "attempt-1",
		repositoryId: "repo-a",
		seq: 0,
		stage: "attempt-started",
		refs: {},
		criteria: { declaredCriterionRefs: [], impactStatus: "not-evaluated" },
		observedAt: "2026-07-17T00:00:00.000Z",
		evidence: [],
		...overrides,
	};
}

function baseSnapshot(overrides: Partial<LandAssessmentSnapshot> = {}): LandAssessmentSnapshot {
	return {
		schemaVersion: SCHEMA_VERSION,
		assessmentKey: "key-1",
		analysisRunId: "run-1",
		state: { base: stateRef("b1"), target: stateRef("t1"), candidate: stateRef("c1") },
		environment,
		observationBatchRefs: [],
		findingRefs: [],
		coverage: [{ dimension: "syntax", covered: 1, total: 1, gaps: [] }],
		outputHash: "hash-1",
		createdAt: "2026-07-17T00:00:00.000Z",
		...overrides,
	};
}

// ── Test harness ─────────────────────────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => {
	__resetShardStateForTests();
});
afterEach(async () => {
	setStorageBackend(new LocalStorageBackend());
	__resetShardStateForTests();
	if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(): Promise<string> {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "land-assessment-store-"));
	return dir;
}

function shardFile(stateDir: string, repositoryId: string, monthKey: string): string {
	return path.join(stateDir, "land-assessment", repoHash16(repositoryId), `events-${monthKey}.jsonl`);
}

async function readLines(file: string): Promise<string[]> {
	const text = await fs.readFile(file, "utf8");
	return text.split("\n").filter((l) => l.trim());
}

/** A recorder that just collects every report it's given, for assertion. */
function collectingRecorder(): { record: (r: Omit<AutomationEvent, "id" | "at" | "loop" | "repo">) => void; reports: Array<Omit<AutomationEvent, "id" | "at" | "loop" | "repo">> } {
	const reports: Array<Omit<AutomationEvent, "id" | "at" | "loop" | "repo">> = [];
	return { record: (r) => reports.push(r), reports };
}

// ── Concurrent-append stress: zero torn lines, correct seq ordering ────────────────────────────────

describe("appendLandAttemptEvent — concurrency", () => {
	test("N parallel writers of multi-KB events yield zero torn lines and correct seq ordering", async () => {
		const stateDir = await tmpDir();
		const N = 40;
		// Multi-KB per event: a large evidence array stresses Node's O_APPEND write() splitting.
		const bigEvidence = Array.from({ length: 200 }, (_, i) => ({ kind: "commit-file" as const, repositoryId: "repo-a", commit: `c${i}`, path: `src/file-${i}.ts`, startLine: 1, endLine: 10 }));
		const events = Array.from({ length: N }, (_, i) => baseEvent({ eventId: `event-${i}`, evidence: bigEvidence }));

		const outcomes = await Promise.all(events.map((e) => appendLandAttemptEvent(stateDir, e)));
		expect(outcomes.every((o) => o === "written")).toBe(true);

		const file = shardFile(stateDir, "repo-a", "2026-07");
		const lines = await readLines(file);
		expect(lines.length).toBe(N);

		const parsed = lines.map((l) => parseStoredLine(l));
		expect(parsed.every((p) => p !== undefined)).toBe(true); // zero torn lines
		const envelopes = parsed as StoredRecordEnvelope[];

		const seqs = envelopes.map((e) => e.seq).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i)); // exactly 0..N-1, no gaps, no dupes

		const eventIds = new Set(envelopes.map((e) => (e.kind === "attempt-event" ? e.record.eventId : "")));
		expect(eventIds.size).toBe(N); // every event's content survived intact, none clobbered
	});

	test("interleaved event and snapshot appends to the same shard still serialize with contiguous seq", async () => {
		const stateDir = await tmpDir();
		const events = Array.from({ length: 10 }, (_, i) => appendLandAttemptEvent(stateDir, baseEvent({ eventId: `e-${i}` })));
		const snaps = Array.from({ length: 10 }, (_, i) => appendLandAssessmentSnapshot(stateDir, baseSnapshot({ assessmentKey: `k-${i}`, outputHash: `h-${i}` })));
		await Promise.all([...events, ...snaps]);

		const file = shardFile(stateDir, "repo-a", "2026-07");
		const lines = await readLines(file);
		expect(lines.length).toBe(20);
		const envelopes = lines.map((l) => parseStoredLine(l)).filter((e): e is StoredRecordEnvelope => e !== undefined);
		expect(envelopes.length).toBe(20);
		const seqs = envelopes.map((e) => e.seq).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
	});
});

// ── CRC detects a torn/corrupted line ───────────────────────────────────────────────────────────────

describe("parseStoredLine — CRC integrity", () => {
	test("a well-formed line round-trips", () => {
		const envelope: StoredRecordEnvelope = { kind: "attempt-event", seq: 3, record: baseEvent() };
		const line = formatStoredLine(envelope);
		expect(parseStoredLine(line)).toEqual(envelope);
	});

	test("an artificially truncated line fails CRC and is rejected, not thrown", () => {
		const envelope: StoredRecordEnvelope = { kind: "attempt-event", seq: 0, record: baseEvent() };
		const line = formatStoredLine(envelope);
		const truncated = line.slice(0, Math.floor(line.length * 0.6)); // simulate a torn write mid-syscall
		expect(() => parseStoredLine(truncated)).not.toThrow();
		expect(parseStoredLine(truncated)).toBeUndefined();
	});

	test("a bit-flipped byte inside the JSON payload fails CRC", () => {
		const envelope: StoredRecordEnvelope = { kind: "attempt-event", seq: 0, record: baseEvent() };
		const line = formatStoredLine(envelope);
		const sep = line.indexOf(":");
		const flipped = line.slice(0, sep + 1) + line.slice(sep + 1).replace('"eventId"', '"eventIdX"');
		expect(parseStoredLine(flipped)).toBeUndefined();
	});

	test("garbage with no ':' separator, or a non-hex CRC prefix, is rejected", () => {
		expect(parseStoredLine("not a stored line at all")).toBeUndefined();
		expect(parseStoredLine("zzzzzz:{}")).toBeUndefined();
	});

	test("a corrupted line on disk is skipped during priming (untouched, uncounted here) and does not derail subsequent seq assignment", async () => {
		const stateDir = await tmpDir();
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e-0" })); // seq 0

		const file = shardFile(stateDir, "repo-a", "2026-07");
		// Simulate a torn concurrent write landing after the valid line, bypassing the store entirely.
		await fs.appendFile(file, "deadbeef:{not valid json\n");

		// Force re-priming from disk (a fresh process would also re-scan on first touch).
		__resetShardStateForTests();
		const outcome = await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "e-1" }));
		expect(outcome).toBe("written");

		const lines = await readLines(file);
		expect(lines.length).toBe(3); // original valid line + the corrupt line (never rewritten) + the new one
		expect(lines[1]).toBe("deadbeef:{not valid json"); // append-only: the corrupt line was never touched

		const validEnvelopes = lines.map((l) => parseStoredLine(l)).filter((e): e is StoredRecordEnvelope => e !== undefined);
		expect(validEnvelopes.length).toBe(2);
		// The corrupt line (no valid seq to read) did not corrupt seq assignment: the new event still
		// gets a seq that doesn't collide with the first valid entry's seq 0.
		expect(new Set(validEnvelopes.map((e) => e.seq)).size).toBe(2);
	});
});

// ── Snapshot dedup ───────────────────────────────────────────────────────────────────────────────────

describe("appendLandAssessmentSnapshot — dedup", () => {
	test("an identical (assessmentKey, outputHash) re-append is dropped, not written twice", async () => {
		const stateDir = await tmpDir();
		const snapshot = baseSnapshot();
		const first = await appendLandAssessmentSnapshot(stateDir, snapshot);
		expect(first).toBe("written");
		const second = await appendLandAssessmentSnapshot(stateDir, { ...snapshot }); // exact re-run, e.g. a retried attempt over an unchanged candidate
		expect(second).toBe("duplicate");

		const file = shardFile(stateDir, "repo-a", "2026-07");
		const lines = await readLines(file);
		expect(lines.length).toBe(1);
	});

	test("same assessmentKey, different outputHash: appended (never dropped) AND surfaces a loud nondeterminism diagnostic, never throws", async () => {
		const stateDir = await tmpDir();
		const { record, reports } = collectingRecorder();
		const first = await appendLandAssessmentSnapshot(stateDir, baseSnapshot({ outputHash: "hash-1" }), record);
		expect(first).toBe("written");

		let threw = false;
		let second: string | undefined;
		try {
			second = await appendLandAssessmentSnapshot(stateDir, baseSnapshot({ outputHash: "hash-2" }), record);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false); // SCHEMA-V0.md: surfaced loudly, never absorbed as a thrown rejection out of the store
		expect(second).toBe("nondeterminism");

		const file = shardFile(stateDir, "repo-a", "2026-07");
		const lines = await readLines(file);
		expect(lines.length).toBe(2); // BOTH outputHashes preserved — append-only history never drops evidence of the disagreement

		const errorReports = reports.filter((r) => r.level === "error");
		expect(errorReports.length).toBe(1);
		expect(errorReports[0]?.detail).toMatch(/NONDETERMINISM/);
		expect(errorReports[0]?.detail).toContain("hash-1");
		expect(errorReports[0]?.detail).toContain("hash-2");
	});

	test("dedup scope is per-shard: the same assessmentKey in a different month is not treated as a duplicate", async () => {
		const stateDir = await tmpDir();
		const julySnap = baseSnapshot({ createdAt: "2026-07-15T00:00:00.000Z" });
		const augustSnap = baseSnapshot({ createdAt: "2026-08-01T00:00:00.000Z" }); // same assessmentKey/outputHash, different month
		expect(await appendLandAssessmentSnapshot(stateDir, julySnap)).toBe("written");
		expect(await appendLandAssessmentSnapshot(stateDir, augustSnap)).toBe("written");

		const julyLines = await readLines(shardFile(stateDir, "repo-a", "2026-07"));
		const augustLines = await readLines(shardFile(stateDir, "repo-a", "2026-08"));
		expect(julyLines.length).toBe(1);
		expect(augustLines.length).toBe(1);
	});
});

// ── Write failure: telemetry, never a thrown rejection ──────────────────────────────────────────────

class FailingBackend implements StorageBackend {
	readonly name = "failing";
	async writeDurable(): Promise<void> {
		throw new Error("disk full");
	}
	writeDurableSync(): void {
		throw new Error("disk full");
	}
	async appendDurable(): Promise<void> {
		throw new Error("disk full");
	}
	async readText(): Promise<string | undefined> {
		return undefined;
	}
	readTextSync(): string | undefined {
		return undefined;
	}
	async readdir(): Promise<string[]> {
		return [];
	}
	async remove(): Promise<void> {}
	async mkdir(): Promise<void> {}
	exists(): boolean {
		return false;
	}
}

describe("write failure", () => {
	test("a failing underlying write surfaces telemetry without throwing to the caller (event append)", async () => {
		const stateDir = await tmpDir();
		setStorageBackend(new FailingBackend());
		const { record, reports } = collectingRecorder();

		let threw = false;
		let outcome: string | undefined;
		try {
			outcome = await appendLandAttemptEvent(stateDir, baseEvent(), record);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(outcome).toBe("write-failed");
		const errorReports = reports.filter((r) => r.level === "error");
		expect(errorReports.length).toBe(1);
		expect(errorReports[0]?.detail).toMatch(/append FAILED/);
		expect(errorReports[0]?.detail).toMatch(/disk full/);
	});

	test("a failing underlying write surfaces telemetry without throwing to the caller (snapshot append)", async () => {
		const stateDir = await tmpDir();
		setStorageBackend(new FailingBackend());
		const { record, reports } = collectingRecorder();

		const outcome = await appendLandAssessmentSnapshot(stateDir, baseSnapshot(), record);
		expect(outcome).toBe("write-failed");
		expect(reports.some((r) => r.level === "error" && /append FAILED/.test(r.detail ?? ""))).toBe(true);
	});

	test("no recorder wired is a safe no-op — the write still fails silently-but-non-throwing", async () => {
		const stateDir = await tmpDir();
		setStorageBackend(new FailingBackend());
		const outcome = await appendLandAttemptEvent(stateDir, baseEvent());
		expect(outcome).toBe("write-failed");
	});

	test("a throwing recorder itself never breaks the store", async () => {
		const stateDir = await tmpDir();
		setStorageBackend(new FailingBackend());
		const outcome = await appendLandAttemptEvent(stateDir, baseEvent(), () => {
			throw new Error("recorder is broken");
		});
		expect(outcome).toBe("write-failed");
	});
});

// ── Shard addressing ─────────────────────────────────────────────────────────────────────────────────

describe("shard addressing", () => {
	test("month sharding is derived from the record's own timestamp, not wall-clock write time", async () => {
		const stateDir = await tmpDir();
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "old", observedAt: "2024-01-15T00:00:00.000Z" }));
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "new", observedAt: "2026-07-17T00:00:00.000Z" }));

		const oldLines = await readLines(shardFile(stateDir, "repo-a", "2024-01"));
		const newLines = await readLines(shardFile(stateDir, "repo-a", "2026-07"));
		expect(oldLines.length).toBe(1);
		expect(newLines.length).toBe(1);
	});

	test("different repositoryIds shard into different directories (repoHash16 mirrors proof.ts's sha1-of-resolved-path convention)", async () => {
		const stateDir = await tmpDir();
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "a", repositoryId: "/repo/a" }));
		await appendLandAttemptEvent(stateDir, baseEvent({ eventId: "b", repositoryId: "/repo/b" }));

		expect(repoHash16("/repo/a")).not.toBe(repoHash16("/repo/b"));
		const linesA = await readLines(shardFile(stateDir, "/repo/a", "2026-07"));
		const linesB = await readLines(shardFile(stateDir, "/repo/b", "2026-07"));
		expect(linesA.length).toBe(1);
		expect(linesB.length).toBe(1);
	});

	test("an unparseable timestamp throws (a corrupt record, not a store fault to swallow)", async () => {
		const stateDir = await tmpDir();
		await expect(appendLandAttemptEvent(stateDir, baseEvent({ observedAt: "not-a-date" }))).rejects.toThrow(/not a parseable timestamp/);
	});
});
