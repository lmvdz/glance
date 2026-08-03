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
 * A flat pair-key set (shape + durability semantics: src/ledger.ts), keyed on the PAIR rather
 * than a single id. Deliberately NOT keyed on the disclosed goal text or strength: the same two
 * units re-overlapping after one of them changes its goal is a new fact worth a fresh card, but
 * the SAME pair is only ever "possibly duplicating work" once.
 *
 * Only ever consulted when BOTH ids are real, stable agent ids — see `createWithId`'s call site.
 * An ad-hoc spawn with no deterministic id has nothing stable to key on and is never resumed
 * identically after a restart anyway (a fresh random id every time), so there is nothing to
 * dedupe there; the ledger is written only for the deterministic-id (resumable) path this
 * incident was actually about.
 */

import { openSetLedger } from "./ledger.ts";

export interface GoalOverlapLedger {
	has(ownerUnitId: string, candidateUnitId: string): boolean;
	add(ownerUnitId: string, candidateUnitId: string): void;
}

/** A minted agent id embeds the operator-chosen display NAME verbatim (`newAgentId`), which can
 *  contain anything the operator typed. `JSON.stringify` of the pair is collision-free regardless
 *  of either id's contents: two different (owner, candidate) splits can never serialize to the
 *  same string, unlike a plain-delimiter join. */
function pairKey(ownerUnitId: string, candidateUnitId: string): string {
	return JSON.stringify([ownerUnitId, candidateUnitId]);
}

export function openGoalOverlapLedger(stateDir: string): GoalOverlapLedger {
	const pairs = openSetLedger(stateDir, "goal-overlap-ledger.json");
	return {
		has: (owner, candidate) => pairs.has(pairKey(owner, candidate)),
		add: (owner, candidate) => pairs.add(pairKey(owner, candidate)),
	};
}
