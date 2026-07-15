/**
 * transcript delta filter (fleet-ide-intervention I01) — the boundary a polling cockpit relies on:
 * strictly-newer-than-since, legacy no-seq entries excluded once a cursor exists, empty-tail at max.
 */
import { expect, test } from "bun:test";
import { transcriptSince } from "../src/transcript-delta.ts";
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
