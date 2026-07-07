/**
 * Persisted Scout scan cursors — agentId → last-scanned transcript ts.
 *
 * The cursor was in-memory only, so every daemon restart/upgrade re-scanned each
 * reattached agent's whole transcript: the persisted seen-set still stopped duplicate
 * tickets, but each re-scan burned a redundant Scout LLM one-shot per agent — real
 * spend on a fleet that restarts often (self-upgrade re-execs the daemon). Persisting
 * the cursor makes the warm-reattach path scan only genuinely new reasoning.
 *
 * Keyed on agent id, which survives a warm reattach (roster + detached host). A COLD
 * re-adoption mints a fresh id and a fresh transcript, so a stale entry is simply
 * never read again; remove() deletes entries write-through.
 *
 * ponytail: one JSON file under <stateDir>, sync write-through on mutation (the
 * manager is single-writer). Ceiling: ids from crashed-before-remove agents linger;
 * pruned lazily on load against the ids the caller knows are gone.
 */

import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";

function cursorPath(stateDir: string): string {
	return path.join(stateDir, "scout-cursor.json");
}

/** Load persisted cursors. Corrupt/unreadable ⇒ empty (worst case: one redundant re-scan per agent). */
export function readScoutCursors(stateDir: string): Map<string, number> {
	try {
		const p = cursorPath(stateDir);
		const b = getStorageBackend();
		if (!b.exists(p)) return new Map();
		const raw0 = b.readTextSync(p);
		if (raw0 === undefined) return new Map();
		const raw = JSON.parse(raw0) as unknown;
		if (!raw || typeof raw !== "object") return new Map();
		const out = new Map<string, number>();
		for (const [id, ts] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof ts === "number" && Number.isFinite(ts)) out.set(id, ts);
		}
		return out;
	} catch {
		return new Map();
	}
}

/** Best-effort write-through — a disk failure must never break the scan it records. */
export function writeScoutCursors(stateDir: string, cursors: Map<string, number>): void {
	try {
		getStorageBackend().writeDurableSync(cursorPath(stateDir), JSON.stringify(Object.fromEntries(cursors)));
	} catch {
		/* best-effort */
	}
}
