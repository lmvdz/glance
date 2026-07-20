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

/**
 * Settle every entry still `status:"running"` to the given terminal status, in place, and return
 * exactly the entries that were flipped (so a caller can re-emit each over the live event channel).
 *
 * A `running` entry can only ever be settled through the live refs held on the AgentRecord
 * (assistantEntry/thinkingEntry/toolEntries) — once the agent process is dead, or the daemon has
 * restarted and rebuilt those refs empty, nothing can flip it again by construction. Left alone it
 * claims "Working" forever: the cockpit's working row keys purely on `status === "running"`, so the
 * chat pane keeps an animated "Working for Ns" ticking while the roster honestly says "agent exited".
 * Deliberately in-place with `seq` untouched: delta pollers pin their cursor below the lowest
 * running seq precisely so an in-place settle is re-fetched; minting a new seq would instead
 * duplicate the row and pin that cursor forever.
 */
export function settleRunningEntries(entries: TranscriptEntry[], status: "error" | "cancelled", now = Date.now()): TranscriptEntry[] {
	const settled: TranscriptEntry[] = [];
	for (const e of entries) {
		if (e.status !== "running") continue;
		e.status = status;
		e.ts = now;
		settled.push(e);
	}
	return settled;
}
