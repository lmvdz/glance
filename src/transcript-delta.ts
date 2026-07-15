/**
 * transcript-delta.ts — the pure delta filter behind `GET /api/agents/:id/transcript?since=<seq>`
 * (fleet-ide-intervention I01). A polling client (the cockpit conversation pane) sends the highest
 * `seq` it has seen and gets only newer entries, instead of refetching the whole transcript.
 */
import type { TranscriptEntry } from "./types.ts";

/** Entries strictly newer than `since` by monotonic `seq`. Legacy entries without a `seq` count as
 *  0, so any `since >= 0` excludes them — a delta poll only grows the tail; a full fetch keeps them. */
export function transcriptSince(entries: TranscriptEntry[], since: number): TranscriptEntry[] {
	return entries.filter((e) => (e.seq ?? 0) > since);
}
