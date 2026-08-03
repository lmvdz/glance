/**
 * Restart-safe auto-dispatch ledger.
 *
 * The Dispatcher already keeps an in-memory set of issue ids it has spawned so a finished/failed
 * agent does not get re-spawned while the Plane issue remains open. A daemon restart used to erase
 * that set, so every still-open issue looked new again and churned another worktree/agent. This
 * tiny JSON ledger is the same set on disk. (Shape + durability semantics: src/ledger.ts —
 * corrupt/unreadable ⇒ in-memory behaviour for this boot, writes best-effort, never crash dispatch.)
 */

import { openSetLedger, type SetLedger } from "./ledger.ts";

export interface DispatchLedger {
	has(issueId: string): boolean;
	add(issueId: string): void;
}

export function openDispatchLedger(stateDir: string): DispatchLedger {
	const ids: SetLedger = openSetLedger(stateDir, "dispatch-ledger.json");
	return {
		has: (issueId) => ids.has(issueId),
		add: (issueId) => ids.add(issueId),
	};
}
