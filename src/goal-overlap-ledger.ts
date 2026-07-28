/**
 * Restart-safe "already disclosed this goal-overlap pair" ledger.
 *
 * PRODUCTION INCIDENT: the goal-overlap disclosure (`squad-manager.ts#createWithId`'s
 * `goalConflict` check, the "Possibly duplicated work" card) only ever remembered what it had
 * already warned about in the daemon's OWN process memory — the `[...this.agents.values()]`
 * roster snapshot the check runs against. A resumed workflow branch keeps a DETERMINISTIC id
 * across restarts (`spawnFleetBranch`'s ids are a pure function of runId/branchKey/nodeId), so
 * every daemon restart rebuilds the same roster, re-runs the same check against the same still-
 * live owner, and re-discloses the exact same (owner, candidate) pair as if it were news. Three
 * restarts over 30 hours meant three identical cards for the same pair in one room.
 *
 * Same tiny-JSON-per-stateDir shape as `dispatch-ledger.ts`/`removed-ledger.ts` (a flat id set,
 * eagerly loaded once, synchronously durable on every write) — this is that exact pattern, keyed
 * on the PAIR rather than a single id. Deliberately NOT keyed on the disclosed goal text or
 * strength: the same two units re-overlapping after one of them changes its goal is a new fact
 * worth a fresh card, but the SAME pair is only ever "possibly duplicating work" once.
 *
 * Only ever consulted when BOTH ids are real, stable agent ids — see `createWithId`'s call site.
 * An ad-hoc spawn with no deterministic id has nothing stable to key on and is never resumed
 * identically after a restart anyway (a fresh random id every time), so there is nothing to
 * dedupe there; the ledger is written only for the deterministic-id (resumable) path this
 * incident was actually about.
 */

import path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";

export interface GoalOverlapLedger {
	has(ownerUnitId: string, candidateUnitId: string): boolean;
	add(ownerUnitId: string, candidateUnitId: string): void;
}

const FILE = "goal-overlap-ledger.json";

/** A minted agent id embeds the operator-chosen display NAME verbatim (`newAgentId`), which can
 *  contain anything the operator typed. `JSON.stringify` of the pair is collision-free regardless
 *  of either id's contents: two different (owner, candidate) splits can never serialize to the
 *  same string, unlike a plain-delimiter join. */
function pairKey(ownerUnitId: string, candidateUnitId: string): string {
	return JSON.stringify([ownerUnitId, candidateUnitId]);
}

function readPairs(stateDir: string): Set<string> {
	try {
		const file = path.join(stateDir, FILE);
		const b = getStorageBackend();
		if (!b.exists(file)) return new Set();
		const raw0 = b.readTextSync(file);
		if (raw0 === undefined) return new Set();
		const raw = JSON.parse(raw0) as unknown;
		if (!Array.isArray(raw)) return new Set();
		return new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0));
	} catch {
		return new Set(); // corrupt/unreadable ⇒ behave as "nothing disclosed" this boot; never crash a spawn
	}
}

function writePairs(stateDir: string, pairs: Set<string>): void {
	try {
		getStorageBackend().writeDurableSync(path.join(stateDir, FILE), JSON.stringify([...pairs].sort()));
	} catch {
		/* best-effort: a disk failure here must not block the spawn the disclosure rides alongside */
	}
}

export function openGoalOverlapLedger(stateDir: string): GoalOverlapLedger {
	const pairs = readPairs(stateDir);
	return {
		has(ownerUnitId, candidateUnitId) {
			return pairs.has(pairKey(ownerUnitId, candidateUnitId));
		},
		add(ownerUnitId, candidateUnitId) {
			const key = pairKey(ownerUnitId, candidateUnitId);
			if (pairs.has(key)) return;
			pairs.add(key);
			writePairs(stateDir, pairs);
		},
	};
}
