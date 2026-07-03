/**
 * Restart-safe auto-dispatch ledger.
 *
 * The Dispatcher already keeps an in-memory set of issue ids it has spawned so a finished/failed
 * agent does not get re-spawned while the Plane issue remains open. A daemon restart used to erase
 * that set, so every still-open issue looked new again and churned another worktree/agent. This
 * tiny JSON ledger is the same set on disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DispatchLedger {
	has(issueId: string): boolean;
	add(issueId: string): void;
}

function readIds(stateDir: string): Set<string> {
	try {
		const file = path.join(stateDir, "dispatch-ledger.json");
		if (!existsSync(file)) return new Set();
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!Array.isArray(raw)) return new Set();
		return new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0));
	} catch {
		return new Set(); // corrupt/unreadable ⇒ in-memory behavior for this boot; never crash dispatch
	}
}

function writeIds(stateDir: string, ids: Set<string>): void {
	try {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(path.join(stateDir, "dispatch-ledger.json"), JSON.stringify([...ids].sort()));
	} catch {
		/* best-effort: disk failure must not break dispatch */
	}
}

export function openDispatchLedger(stateDir: string): DispatchLedger {
	const ids = readIds(stateDir);
	return {
		has(issueId) {
			return ids.has(issueId);
		},
		add(issueId) {
			if (ids.has(issueId)) return;
			ids.add(issueId);
			writeIds(stateDir, ids);
		},
	};
}
