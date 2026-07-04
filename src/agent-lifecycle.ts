/**
 * agent-lifecycle — pure status-derivation and transition-legality rules for SquadManager.
 *
 * Kept free of SquadManager/AgentRecord imports so it stays unit-testable with plain objects
 * (tests/agent-lifecycle.test.ts). SquadManager.transition()/setPending() are the only callers.
 */

import type { AgentStatus, TransitionEntry } from "./types.ts";

/** Reasons that derive status purely from existing signals (turn state, pending queue).
 *  Class D: sticky against stopped/error — mirrors derive()'s guard (squad-manager.ts's `derive()`)
 *  and applyState's reconciliation guard exactly. */
export type DerivedReason = "turn-progress" | "pending-add" | "pending-answer" | "pending-cancel";

/** Reasons the manager asserts explicitly (a human/operator/system act, not a derivation).
 *  Class E: legal from ANY state, including terminal→terminal — verified sites:
 *  exit-clean/exit-error do error↔stopped on a clean/dirty child exit (wire()'s exit handler),
 *  catastrophe does any→error (markCatastrophe), fail does any→error (fail()), connect-begin walks
 *  stopped/error→starting in ensureConnected, abort does any→stopped (runAgentTask's onAbort). */
export type ExplicitReason =
	| "spawn" | "connect-begin" | "connect-ok" | "restart" | "kill" | "abort"
	| "exit-clean" | "exit-error" | "fail" | "catastrophe" | "task-start" | "branch-start" | "reattach" | "adopted"
	// Synthetic, same-state, best-effort marker recorded once per live agent in SquadManager.stop() (a
	// graceful daemon shutdown DETACHES agents rather than stopping them, so this is a timeline note —
	// "the daemon paused supervision here" — not an actual status change).
	| "daemon-stop";

export type TransitionReason = DerivedReason | ExplicitReason;

const DERIVED_REASONS = new Set<DerivedReason>(["turn-progress", "pending-add", "pending-answer", "pending-cancel"]);

export function isDerivedReason(reason: TransitionReason): reason is DerivedReason {
	return DERIVED_REASONS.has(reason as DerivedReason);
}

/** True if `to` is a legal transition from `from` given `reason`.
 *  Class D (derived): stopped/error are terminal — never leaves them (reproduces derive()'s guard).
 *  Class E (explicit): legal from any state, including terminal→terminal. */
export function canTransition(from: AgentStatus, to: AgentStatus, reason: TransitionReason): boolean {
	if (isDerivedReason(reason)) return !(from === "stopped" || from === "error");
	return true;
}

/** Pure status derivation — moved verbatim from SquadManager.derive().
 *  SquadManager.derive() becomes a thin wrapper calling this with rec's live fields. */
export function deriveStatus(input: { status: AgentStatus; pendingCount: number; streaming: boolean }): AgentStatus {
	if (input.status === "stopped" || input.status === "error") return input.status;
	if (input.pendingCount > 0) return "input";
	if (input.streaming) return "working";
	return "idle";
}

/** Drop duplicate transition entries, keeping first-seen order. Used when merging the persisted file
 *  with the in-memory ring, which overlap at the boundary.
 *
 *  Identity: prefers the entry's `seq` (a uuid stamped at record time — see TransitionEntry) when
 *  present. The OLD composite key (agentId,at,reason) is only a fallback for entries written before
 *  `seq` existed — it is provably wrong as a primary key (#lifecycle-truth finding 7): distinct
 *  same-millisecond transitions with the same reason (e.g. closeOrphanedPending recording several
 *  "pending-cancel" entries for the same agent in one adopt) collapse into one, so `full=1` could
 *  return FEWER entries than the capped ring-only view. */
export function dedupeTransitions(entries: TransitionEntry[]): TransitionEntry[] {
	const seen = new Set<string>();
	const out: TransitionEntry[] = [];
	for (const e of entries) {
		const key = typeof e.seq === "string" ? `seq:${e.seq}` : `${e.agentId}|${e.at}|${e.reason}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(e);
	}
	return out;
}

/** Walk `cause.priorId` backwards from `id` (bounded hops) over `all` — every known TransitionEntry
 *  across every agent (ring ∪ file) — concatenating each prior id's entries ahead of `id`'s own, so a
 *  cold-adopted agent's post-adopt history reads as one continuous pre/post-crash timeline. Pure over
 *  TransitionEntry[] (no AgentRecord/SquadManager access needed) so it stays unit-testable standalone. */
export function followLineage(id: string, all: TransitionEntry[], maxHops = 10): TransitionEntry[] {
	let cursor = id;
	let out = all.filter((e) => e.agentId === cursor);
	for (let hop = 0; hop < maxHops; hop++) {
		const priorId = out.find((e) => e.agentId === cursor && typeof e.cause?.priorId === "string")?.cause?.priorId;
		if (typeof priorId !== "string") break;
		const priorEntries = all.filter((e) => e.agentId === priorId);
		if (!priorEntries.length) break;
		out = [...priorEntries, ...out];
		cursor = priorId;
	}
	return dedupeTransitions(out);
}
