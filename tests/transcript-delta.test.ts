/**
 * transcript delta filter (fleet-ide-intervention I01) — the boundary a polling cockpit relies on:
 * strictly-newer-than-since, legacy no-seq entries excluded once a cursor exists, empty-tail at max.
 */
import { expect, test } from "bun:test";
import { settleRunningEntries, transcriptSince } from "../src/transcript-delta.ts";
import type { TranscriptEntry } from "../src/types.ts";

function e(seq: number | undefined, text: string): TranscriptEntry {
	return { seq, kind: "text", text, ts: 0 } as TranscriptEntry;
}

test("returns only entries with seq strictly greater than since", () => {
	const t = [e(1, "a"), e(2, "b"), e(3, "c")];
	expect(transcriptSince(t, 1).map((x) => x.text)).toEqual(["b", "c"]);
	expect(transcriptSince(t, 0).map((x) => x.text)).toEqual(["a", "b", "c"]);
});

test("since at the max seq returns an empty tail", () => {
	expect(transcriptSince([e(1, "a"), e(2, "b")], 2)).toEqual([]);
});

test("legacy entries without seq count as 0 — excluded once a real cursor is set", () => {
	const t = [e(undefined, "legacy"), e(1, "new")];
	// A delta poll (since >= 0) never re-sends the seq-less legacy entry...
	expect(transcriptSince(t, 0).map((x) => x.text)).toEqual(["new"]);
	// ...but a negative sentinel would include it (a full fetch uses getTranscript, not this).
	expect(transcriptSince(t, -1).map((x) => x.text)).toEqual(["legacy", "new"]);
});

test("empty transcript yields empty", () => {
	expect(transcriptSince([], 5)).toEqual([]);
});

// ── settleRunningEntries — the dead-process floor behind "Blocked in the sidebar, Working in the chat" ──

function s(seq: number, status: TranscriptEntry["status"], text: string): TranscriptEntry {
	return { seq, kind: "assistant", text, ts: 100, status } as TranscriptEntry;
}

test("settles exactly the running entries, in place, and returns them", () => {
	const t = [s(1, "ok", "done"), s(2, "running", "mid-stream"), s(3, "error", "failed"), s(4, "running", "tool"), s(5, "cancelled", "steered")];
	const settled = settleRunningEntries(t, "error", 999);
	expect(settled.map((x) => x.seq)).toEqual([2, 4]);
	expect(t.map((x) => x.status)).toEqual(["ok", "error", "error", "error", "cancelled"]);
	// In place: the returned objects ARE the array's objects (the live re-emit relies on identity)...
	expect(settled[0]).toBe(t[1] as TranscriptEntry);
	// ...with ts stamped to the settle moment and seq deliberately untouched (a delta poller's
	// runningFloor cursor re-fetches the same seq; a new seq would duplicate the row instead).
	expect(settled.map((x) => x.ts)).toEqual([999, 999]);
});

test("statusless and terminal entries are never touched; no running entries means an empty settle", () => {
	const legacy = { seq: 1, kind: "user", text: "hi", ts: 5 } as TranscriptEntry;
	const t = [legacy, s(2, "ok", "done")];
	expect(settleRunningEntries(t, "cancelled")).toEqual([]);
	expect(legacy.status).toBeUndefined();
	expect(t[1]?.ts).toBe(100);
});
