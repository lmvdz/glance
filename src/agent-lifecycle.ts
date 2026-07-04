/**
 * agent-lifecycle — pure status-derivation and transition-legality rules for SquadManager.
 *
 * Kept free of SquadManager/AgentRecord imports so it stays unit-testable with plain objects
 * (tests/agent-lifecycle.test.ts). SquadManager.transition()/setPending() are the only callers.
 */

import type { AgentStatus } from "./types.ts";

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
	| "exit-clean" | "exit-error" | "fail" | "catastrophe" | "task-start" | "branch-start" | "reattach" | "adopted";

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
