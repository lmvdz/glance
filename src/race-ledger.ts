/**
 * Restart-safe race-once ledger (adw-factory-borrows concern 07).
 *
 * At workflow catastrophe (visit-cap exhaustion) of an issue-carrying, race-eligible unit, the daemon
 * parks the original and spawns exactly one fresh-context, alternate-strategy sibling before ever
 * summoning a human. "Exactly one, ever" is the whole invariant — an in-memory Set alone re-fires the
 * race after a daemon restart between the original's catastrophe and the sibling's own completion
 * (red-team C3.3), so this is a persisted ledger (shape + durability semantics: src/ledger.ts).
 * Unlike a plain id set, a race needs BOTH attempts' detail on hand for the (at most one) second
 * catastrophe's escalation message, so this stores a small record per issue rather than just
 * membership.
 */

import { openMapLedger } from "./ledger.ts";

/** One persisted race, keyed by issue id — the original that catastrophe'd, the sibling raced in its
 *  place, and the strategy it was given, so a later escalation (the sibling ALSO fails) can name both
 *  attempts instead of just the second. */
export interface RaceRecord {
	issueId: string;
	originalAgentId: string;
	originalDetail: string;
	siblingAgentId: string;
	strategy: string;
	racedAt: number;
}

export interface RaceLedger {
	/** The persisted race for this issue, if one has ever been spawned. Present ⇒ the race budget for
	 *  this issue is spent — a further catastrophe (the sibling's own) must escalate, never race again. */
	get(issueId: string): RaceRecord | undefined;
	/** Stamp the ledger. First-wins and idempotent: a race is a once-per-issue-ever fact, so a second
	 *  call for an already-recorded issue is a no-op rather than overwriting the original attempt's detail. */
	record(rec: RaceRecord): void;
}

export function openRaceLedger(stateDir: string): RaceLedger {
	const all = openMapLedger<RaceRecord>(stateDir, "race-ledger.json");
	return {
		get: (issueId) => all.get(issueId),
		record(rec) {
			// First-wins (once per issue, ever), with ONE legal refinement: the claim-then-spawn flow
			// stamps a "pending" placeholder BEFORE the sibling exists (fail-closed crash-window guard)
			// and refines it with the real sibling id/strategy after create() resolves — same original
			// only, so no other caller can ever repurpose a stamped issue.
			const existing = all.get(rec.issueId);
			const refinesPending = existing?.siblingAgentId === "pending" && existing.originalAgentId === rec.originalAgentId;
			if (existing && !refinesPending) return;
			all.put(rec.issueId, rec);
		},
	};
}
