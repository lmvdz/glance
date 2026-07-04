/**
 * agent-lifecycle — pure transition-legality + status-derivation rules.
 * Class D (derived) reasons never leave stopped/error; Class E (explicit) reasons are legal
 * from every state, including terminal→terminal (the code-verified sites that make a flat
 * RESET_REASONS allow-list wrong: exit-clean from error, catastrophe from stopped, connect-begin
 * from error).
 */

import { expect, test } from "bun:test";
import { canTransition, dedupeTransitions, deriveStatus, isDerivedReason } from "../src/agent-lifecycle.ts";
import type { AgentStatus, TransitionEntry } from "../src/types.ts";

const ALL_STATUSES: AgentStatus[] = ["starting", "working", "idle", "input", "error", "stopped"];

test("isDerivedReason classifies the two reason classes", () => {
	expect(isDerivedReason("turn-progress")).toBe(true);
	expect(isDerivedReason("pending-add")).toBe(true);
	expect(isDerivedReason("pending-answer")).toBe(true);
	expect(isDerivedReason("pending-cancel")).toBe(true);
	expect(isDerivedReason("spawn")).toBe(false);
	expect(isDerivedReason("catastrophe")).toBe(false);
	expect(isDerivedReason("exit-clean")).toBe(false);
	expect(isDerivedReason("connect-begin")).toBe(false);
});

test("derived reasons never leave stopped or error", () => {
	for (const reason of ["turn-progress", "pending-add", "pending-answer", "pending-cancel"] as const) {
		expect(canTransition("stopped", "idle", reason)).toBe(false);
		expect(canTransition("stopped", "working", reason)).toBe(false);
		expect(canTransition("error", "idle", reason)).toBe(false);
		expect(canTransition("error", "input", reason)).toBe(false);
		// canTransition only gates on `from`, not `to` — SquadManager.transition() never calls it for a
		// same-state derived request (that's handled by its own from===to early-return before canTransition
		// is even consulted), so canTransition's terminal-from behavior is consistent regardless of `to`.
		expect(canTransition("stopped", "stopped", reason)).toBe(false);
		expect(canTransition("error", "error", reason)).toBe(false);
		// moving between non-terminal states is unaffected by the guard
		expect(canTransition("idle", "working", reason)).toBe(true);
	}
});

test("explicit reasons are legal from every state, including terminal→terminal", () => {
	const explicitReasons = ["spawn", "connect-begin", "connect-ok", "restart", "kill", "abort", "exit-clean", "exit-error", "fail", "catastrophe", "task-start", "branch-start", "reattach", "adopted", "daemon-stop"] as const;
	for (const reason of explicitReasons) {
		for (const from of ALL_STATUSES) {
			for (const to of ALL_STATUSES) {
				expect(canTransition(from, to, reason)).toBe(true);
			}
		}
	}
});

test("explicit-class site table: the four transitions that prove a flat RESET_REASONS table wrong", () => {
	// wire()'s exit handler: error -> stopped on a clean child exit.
	expect(canTransition("error", "stopped", "exit-clean")).toBe(true);
	// markCatastrophe: any -> error, including from a terminal stopped state.
	expect(canTransition("stopped", "error", "catastrophe")).toBe(true);
	// fail(): any -> error.
	expect(canTransition("working", "error", "fail")).toBe(true);
	// ensureConnected: stopped/error -> starting (reconnect attempt on a dead agent).
	expect(canTransition("stopped", "starting", "connect-begin")).toBe(true);
	expect(canTransition("error", "starting", "connect-begin")).toBe(true);
});

test("deriveStatus: stopped/error are sticky regardless of pending/streaming", () => {
	expect(deriveStatus({ status: "stopped", pendingCount: 3, streaming: true })).toBe("stopped");
	expect(deriveStatus({ status: "error", pendingCount: 0, streaming: true })).toBe("error");
});

test("deriveStatus: pending beats streaming", () => {
	expect(deriveStatus({ status: "idle", pendingCount: 1, streaming: true })).toBe("input");
});

test("deriveStatus: streaming beats idle", () => {
	expect(deriveStatus({ status: "idle", pendingCount: 0, streaming: true })).toBe("working");
});

test("deriveStatus: no pending, not streaming -> idle", () => {
	expect(deriveStatus({ status: "starting", pendingCount: 0, streaming: false })).toBe("idle");
});

function entry(patch: Partial<TransitionEntry>): TransitionEntry {
	return { agentId: "a1", from: "idle", to: "input", reason: "pending-add", at: 1000, ...patch };
}

test("dedupeTransitions: seq is the identity when present — same-millisecond, same-reason entries with distinct seq are NOT collapsed (finding 7)", () => {
	// closeOrphanedPending-style burst: several pending-cancel entries for the same agent recorded in the
	// same millisecond. The old (agentId,at,reason) composite key would wrongly collapse these to one.
	const a = entry({ reason: "pending-cancel", seq: "seq-1" });
	const b = entry({ reason: "pending-cancel", seq: "seq-2" });
	const c = entry({ reason: "pending-cancel", seq: "seq-3" });
	expect(dedupeTransitions([a, b, c])).toEqual([a, b, c]);
});

test("dedupeTransitions: a genuine duplicate (same seq) still collapses, keeping first-seen order", () => {
	const a = entry({ seq: "same-seq" });
	const dupe = entry({ seq: "same-seq", at: 2000 }); // even a differing field elsewhere is still the same record
	expect(dedupeTransitions([a, dupe])).toEqual([a]);
});

test("dedupeTransitions: falls back to the (agentId,at,reason) composite for pre-seq entries (no `seq` field)", () => {
	const legacyA = entry({}); // no seq — as if hydrated from a transitions.jsonl line written before this fix
	const legacyDupe = entry({});
	const distinct = entry({ reason: "pending-answer" });
	expect(dedupeTransitions([legacyA, legacyDupe, distinct])).toEqual([legacyA, distinct]);
});
