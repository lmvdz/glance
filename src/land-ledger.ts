/**
 * Branch-keyed auto-land failure ledger — the restart-safe retry cap for autonomous landing.
 *
 * The orchestrator's in-memory cap reset on every daemon restart, and the workflow_done auto-land
 * path (autoLandOnSuccess) had NO cap at all — so a branch whose merge keeps failing the acceptance
 * gate was merged + rolled-back forever, churning main. The count must therefore persist across
 * restarts AND key on something stable across them: the BRANCH, not the agent id (create() mints a
 * fresh id on every re-adoption of a surviving worktree).
 *
 * ponytail: one JSON file under <stateDir>, sync read-modify-write (the manager is single-writer,
 * single event loop, so no interleave). Ceiling: the file grows one entry per ever-failing branch
 * and is pruned only to live branches by the Observer's read; a very long-lived daemon with churn
 * could accumulate dead entries. Upgrade path: prune on write, or fold into the sqlite ledger.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface LandFailure {
	/** Consecutive failed auto-lands for this branch (a successful land clears the entry). */
	fails: number;
	/** Truncated detail of the latest failure — fed into the Observer's bug issue. */
	lastDetail: string;
	/** ms epoch of the latest failure. */
	at: number;
}
/** branch → its failure streak. */
export type LandLedger = Record<string, LandFailure>;

function ledgerPath(stateDir: string): string {
	return path.join(stateDir, "land-failures.json");
}

export function readLandLedger(stateDir: string): LandLedger {
	try {
		const p = ledgerPath(stateDir);
		if (!existsSync(p)) return {};
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		return raw && typeof raw === "object" ? (raw as LandLedger) : {};
	} catch {
		return {}; // corrupt/unreadable ⇒ start fresh (worst case: the cap forgets one branch's streak)
	}
}

function writeLandLedger(stateDir: string, ledger: LandLedger): void {
	try {
		writeFileSync(ledgerPath(stateDir), JSON.stringify(ledger));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/** Consecutive failed auto-lands recorded for `branch` (0 when none / unknown). */
export function landFailureCount(stateDir: string, branch: string): number {
	return readLandLedger(stateDir)[branch]?.fails ?? 0;
}

/**
 * Record one auto-land outcome for `branch`: a success CLEARS the streak, a failure BUMPS it.
 * Returns the new streak. No-op key for an undefined branch.
 */
export function recordLandOutcome(stateDir: string, branch: string | undefined, ok: boolean, detail: string, now = Date.now()): number {
	if (!branch) return 0;
	const ledger = readLandLedger(stateDir);
	if (ok) {
		if (ledger[branch]) {
			delete ledger[branch];
			writeLandLedger(stateDir, ledger);
		}
		return 0;
	}
	const fails = (ledger[branch]?.fails ?? 0) + 1;
	ledger[branch] = { fails, lastDetail: detail.slice(0, 600), at: now };
	writeLandLedger(stateDir, ledger);
	return fails;
}

/**
 * Forced-land audit trail — a force-land is a human override that bypasses the proof gate. It must
 * never be invisible trust: every land that merged WITHOUT a passing proof (forcedWithoutProof) is
 * appended here with the actor + timestamp, so "who force-landed what, unproven, when" is inspectable.
 * Append-only JSON list under <stateDir>; best-effort (a disk failure must never break the land).
 */
export interface ForcedLand {
	/** The branch that was force-landed without a passing proof. */
	branch: string;
	/** The actor id that forced it (LOCAL_ACTOR for an operator, or a specific identity). */
	actor: string;
	/** Truncated land detail — why the proof gate was not satisfied. */
	detail: string;
	/** ms epoch of the forced land. */
	at: number;
}

function forcedPath(stateDir: string): string {
	return path.join(stateDir, "land-forced.json");
}

/** Every forced (proof-bypassing) land recorded, oldest first. Corrupt/missing ⇒ empty. */
export function readForcedLands(stateDir: string): ForcedLand[] {
	try {
		const p = forcedPath(stateDir);
		if (!existsSync(p)) return [];
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		return Array.isArray(raw) ? (raw as ForcedLand[]) : [];
	} catch {
		return [];
	}
}

/** Append one forced-land audit record. No-op for an undefined branch. Returns the new record count. */
export function recordForcedLand(stateDir: string, branch: string | undefined, actor: string, detail: string, now = Date.now()): number {
	if (!branch) return readForcedLands(stateDir).length;
	const list = readForcedLands(stateDir);
	list.push({ branch, actor, detail: detail.slice(0, 600), at: now });
	try {
		writeFileSync(forcedPath(stateDir), JSON.stringify(list));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
	return list.length;
}
