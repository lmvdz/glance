/**
 * Restart-safe ledger of the Orchestrator's verify/land decisions.
 *
 * Entries are keyed by repo + branch + current HEAD when HEAD is available. That keeps a restarted
 * daemon from re-driving the same work, but a branch name reused at a new commit is treated as fresh
 * work instead of being skipped by a stale branch-only terminal decision.
 *
 * ponytail: one JSON file under <stateDir>, read once into memory, write-through on mutation
 * (the manager is single-writer, single event loop). Write failures throw so the orchestrator can
 * fail closed before verify/land rather than continue after losing a critical state transition.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** Decision classes the loop must not re-litigate after a restart. */
type Kind = "verifying" | "verified" | "blocked" | "halted" | "landed" | "staged";
const KINDS: Kind[] = ["verifying", "verified", "blocked", "halted", "landed", "staged"];

/** Identity key built by the orchestrator from repo + branch + HEAD/run identity. */
export type OrchestratorStateKey = string;

/** Durable decision store consulted by the Orchestrator each tick. */
export interface OrchestratorPersistence {
	isVerifying(key: OrchestratorStateKey): boolean;
	isVerified(key: OrchestratorStateKey): boolean;
	isBlocked(key: OrchestratorStateKey): boolean;
	isHalted(key: OrchestratorStateKey): boolean;
	isLanded(key: OrchestratorStateKey): boolean;
	isStaged(key: OrchestratorStateKey): boolean;
	markVerifying(key: OrchestratorStateKey): void;
	markVerified(key: OrchestratorStateKey): void;
	markBlocked(key: OrchestratorStateKey): void;
	markHalted(key: OrchestratorStateKey): void;
	markLanded(key: OrchestratorStateKey): void;
	markStaged(key: OrchestratorStateKey): void;
	/**
	 * Purge ledger entries for branch identities that no longer exist in the current roster.
	 * A stale HEAD for a still-live branch is also dropped because a newer key now represents it.
	 */
	purgeStale(liveKeys: OrchestratorStateKey[]): void;
}

/** Open (or create) the on-disk ledger under `stateDir`, loading any prior decisions into memory. */
export function openOrchestratorState(stateDir: string): OrchestratorPersistence {
	const file = path.join(stateDir, "orchestrator-state.json");
	const sets: Record<Kind, Set<string>> = { verifying: new Set(), verified: new Set(), blocked: new Set(), halted: new Set(), landed: new Set(), staged: new Set() };
	try {
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Record<Kind, unknown>>;
			for (const k of KINDS) {
				const v = raw?.[k];
				if (Array.isArray(v)) sets[k] = new Set(v.filter((x): x is string => typeof x === "string"));
			}
		}
	} catch {
		/* corrupt/unreadable ⇒ start fresh (worst case: one redundant verify / re-summon per branch) */
	}

	const flush = (): void => {
		writeFileSync(file, JSON.stringify({ verifying: [...sets.verifying], verified: [...sets.verified], blocked: [...sets.blocked], halted: [...sets.halted], landed: [...sets.landed], staged: [...sets.staged] }));
	};
	const mark = (k: Kind, key: string): void => {
		if (key && !sets[k].has(key)) {
			sets[k].add(key);
			flush();
		}
	};

	const purgeStale = (liveKeys: string[]): void => {
		const live = new Set(liveKeys.filter(Boolean));
		let changed = false;
		for (const k of KINDS) {
			for (const key of [...sets[k]]) {
				if (!live.has(key)) {
					sets[k].delete(key);
					changed = true;
				}
			}
		}
		if (changed) flush();
	};

	return {
		isVerifying: (b) => !!b && sets.verifying.has(b),
		isVerified: (b) => !!b && sets.verified.has(b),
		isBlocked: (b) => !!b && sets.blocked.has(b),
		isHalted: (b) => !!b && sets.halted.has(b),
		isLanded: (b) => !!b && sets.landed.has(b),
		isStaged: (b) => !!b && sets.staged.has(b),
		markVerifying: (b) => mark("verifying", b),
		markVerified: (b) => mark("verified", b),
		markBlocked: (b) => mark("blocked", b),
		markHalted: (b) => mark("halted", b),
		markLanded: (b) => mark("landed", b),
		markStaged: (b) => mark("staged", b),
		purgeStale,
	};
}
