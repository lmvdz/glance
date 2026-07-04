/**
 * Concern 03 (never-lose-work): the append-only per-run checkpoint log — seq derivation across a
 * simulated daemon restart (fresh in-memory map, existing file), torn-trailing-line read tolerance,
 * and 4KB field truncation. No SquadManager/driver involved — the module is a pure JSONL accumulator,
 * same style as receipts.test.ts.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCheckpoint, checkpointLogPath, deleteCheckpointLog, getLastSeq, readCheckpoints } from "../src/workflow/checkpoint-log.ts";
import type { WorkflowRunState } from "../src/workflow/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-log-"));
	tmps.push(dir);
	return dir;
}

function state(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
	return { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [], runId: "run-1", ...overrides };
}

test("appendCheckpoint assigns 0,1,2 then continues at 3,4 after a simulated restart with no duplicates or gaps", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-restart";

	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "a" }));
	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "b" }));
	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "c" }));

	const beforeRestart = await readCheckpoints(stateDir, runId);
	expect(beforeRestart.map((e) => e.seq)).toEqual([0, 1, 2]);

	// Simulate a fresh process boot: nothing in this test file imports its own module cache reset, so
	// instead assert directly against the file's line count — a fresh import of checkpoint-log.ts in a
	// new process would derive the SAME seq from lineCount(file), which is exactly what we're testing.
	// Verify by re-deriving from the file bypassing the in-memory map: read the raw line count first.
	const rawLines = (await fs.readFile(checkpointLogPath(stateDir, runId), "utf8")).trim().split("\n").length;
	expect(rawLines).toBe(3);

	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "d" }));
	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "e" }));

	const all = await readCheckpoints(stateDir, runId);
	expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
	expect(all.map((e) => e.currentNode)).toEqual(["a", "b", "c", "d", "e"]);
});

test("appendCheckpoint on a fresh runId in a NEW process (no in-memory entry) resumes from the file's line count", async () => {
	// Directly exercises the "no entry in the map yet" branch by writing 2 raw lines to the file first,
	// then calling appendCheckpoint for a runId this process has never touched.
	const stateDir = await tmpStateDir();
	const runId = "run-preexisting";
	const file = checkpointLogPath(stateDir, runId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify({ ...state({ runId }), seq: 0, at: 1 })}\n${JSON.stringify({ ...state({ runId }), seq: 1, at: 2 })}\n`);

	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "z" }));

	const entries = await readCheckpoints(stateDir, runId);
	expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
	expect(entries[2]!.currentNode).toBe("z");
});

test("readCheckpoints skips a torn trailing line and sorts by seq", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-torn";
	const file = checkpointLogPath(stateDir, runId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	// Line 1 well-formed (seq 1), line 0 well-formed but written second (out of file order), line 2 torn.
	const lines = [JSON.stringify({ ...state({ runId }), seq: 1, at: 2 }), JSON.stringify({ ...state({ runId }), seq: 0, at: 1 }), `{"seq":2,"cur`];
	await fs.writeFile(file, lines.join("\n") + "\n");

	const entries = await readCheckpoints(stateDir, runId);
	expect(entries.map((e) => e.seq)).toEqual([0, 1]);
});

// Review finding 7: a crash mid-append leaves a partial line with NO trailing newline. Before this fix,
// the next appendCheckpoint's seq-init (lineCount) counted the torn fragment as a whole line, and its
// fs.appendFile() glued its own write directly onto the fragment's tail (no newline between them) —
// producing ONE unparseable merged line. That's a permanent seq hole: both the torn entry AND the fully-
// written one that got glued onto it become unreadable forever, and a forkPoint.seq referencing either
// becomes un-forkable.
test("appendCheckpoint repairs a torn trailing line on disk instead of merging the next write onto it", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-torn-append";
	const file = checkpointLogPath(stateDir, runId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	// Two complete lines (seq 0, 1) followed by a torn fragment with NO trailing newline — simulates a
	// crash mid-append of what would have been seq 2.
	const complete = [JSON.stringify({ ...state({ runId }), seq: 0, at: 1 }), JSON.stringify({ ...state({ runId }), seq: 1, at: 2 })];
	await fs.writeFile(file, `${complete.join("\n")}\n{"seq":2,"cur`);
	expect((await fs.readFile(file, "utf8")).endsWith("\n")).toBe(false); // sanity: genuinely torn

	// Must start at seq 2 (the count of COMPLETE lines) — the old lineCount() bug would count the torn
	// fragment as a whole line and start at 3 — and must never glue onto the fragment's tail.
	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "repaired" }));

	const raw = await fs.readFile(file, "utf8");
	for (const line of raw.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow(); // no merged line

	const entries = await readCheckpoints(stateDir, runId);
	expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
	expect(entries[2]!.currentNode).toBe("repaired");
});

// Companion: the log can be torn from its very first write (zero complete entries survive).
test("appendCheckpoint repairs a log that is entirely a torn line with zero complete entries", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-all-torn";
	const file = checkpointLogPath(stateDir, runId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `{"seq":0,"cur`); // torn from the very first write — nothing parseable at all

	await appendCheckpoint(stateDir, runId, state({ runId, currentNode: "first" }));

	const entries = await readCheckpoints(stateDir, runId);
	expect(entries.map((e) => e.seq)).toEqual([0]);
	expect(entries[0]!.currentNode).toBe("first");
});

test("readCheckpoints on a missing file returns an empty array", async () => {
	const stateDir = await tmpStateDir();
	expect(await readCheckpoints(stateDir, "never-existed")).toEqual([]);
});

test("appendCheckpoint truncates vars.lastOutput/lastText beyond 4KB with a truncated suffix", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-truncate";
	const long = "x".repeat(5000);
	await appendCheckpoint(stateDir, runId, state({ runId, vars: { lastOutput: long, lastText: long, keep: "short" } }));

	const [entry] = await readCheckpoints(stateDir, runId);
	expect(entry!.vars!.lastOutput!.length).toBe(4096 + "…(truncated)".length);
	expect(entry!.vars!.lastOutput!.endsWith("…(truncated)")).toBe(true);
	expect(entry!.vars!.lastText!.endsWith("…(truncated)")).toBe(true);
	expect(entry!.vars!.keep).toBe("short"); // untouched field survives verbatim
});

test("getLastSeq reflects the count of durably appended entries", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-lastseq";
	expect(await getLastSeq(stateDir, runId)).toBe(0);
	await appendCheckpoint(stateDir, runId, state({ runId }));
	expect(await getLastSeq(stateDir, runId)).toBe(1);
	await appendCheckpoint(stateDir, runId, state({ runId }));
	expect(await getLastSeq(stateDir, runId)).toBe(2);
});

test("deleteCheckpointLog removes the file and clears in-memory seq tracking", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-delete";
	await appendCheckpoint(stateDir, runId, state({ runId }));
	await fs.access(checkpointLogPath(stateDir, runId)); // throws (failing the test) if the file is missing

	await deleteCheckpointLog(stateDir, runId);

	await expect(fs.access(checkpointLogPath(stateDir, runId))).rejects.toThrow();
	// Re-appending after delete starts a fresh count from 0 (file gone ⇒ lineCount 0), not the stale in-memory seq.
	await appendCheckpoint(stateDir, runId, state({ runId }));
	const entries = await readCheckpoints(stateDir, runId);
	expect(entries.map((e) => e.seq)).toEqual([0]);
});

test("deleteCheckpointLog on a never-created log is a no-op", async () => {
	const stateDir = await tmpStateDir();
	await expect(deleteCheckpointLog(stateDir, "never-existed")).resolves.toBeUndefined();
});

test("concurrent appendCheckpoint calls for the same runId are serialized (no interleaving, no dropped seq)", async () => {
	const stateDir = await tmpStateDir();
	const runId = "run-concurrent";
	await Promise.all(Array.from({ length: 10 }, (_, i) => appendCheckpoint(stateDir, runId, state({ runId, currentNode: `n${i}` }))));
	const entries = await readCheckpoints(stateDir, runId);
	expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	// Every seq value appears exactly once — no duplicate assignment under concurrent chained appends.
	expect(new Set(entries.map((e) => e.seq)).size).toBe(10);
});
