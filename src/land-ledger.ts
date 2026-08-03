/**
 * Branch-keyed auto-land failure ledger — the restart-safe retry cap for autonomous landing.
 *
 * The orchestrator's in-memory cap reset on every daemon restart, and the workflow_done auto-land
 * path (autoLandOnSuccess) had NO cap at all — so a branch whose merge keeps failing the acceptance
 * gate was merged + rolled-back forever, churning main. The count must therefore persist across
 * restarts AND key on something stable across them: the BRANCH, not the agent id (create() mints a
 * fresh id on every re-adoption of a surviving worktree).
 *
 * One JSON file under <stateDir>, sync read-modify-write per call (the manager is single-writer,
 * single event loop, so no interleave) — shape + durability semantics: src/ledger.ts, which also
 * made these writes atomic+durable (this file historically used raw non-atomic `node:fs`, the only
 * ledger that bypassed the storage seam). Ceiling: the file grows one entry per ever-failing branch
 * and is pruned only to live branches by the Observer's read; a very long-lived daemon with churn
 * could accumulate dead entries. Upgrade path: prune on write, or fold into the sqlite ledger.
 */

import { listFile, mapFile } from "./ledger.ts";

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

const failures = (stateDir: string) => mapFile<LandFailure>(stateDir, "land-failures.json");

export function readLandLedger(stateDir: string): LandLedger {
	return failures(stateDir).read();
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
	const file = failures(stateDir);
	const ledger = file.read();
	if (ok) {
		if (ledger[branch]) {
			delete ledger[branch];
			file.write(ledger);
		}
		return 0;
	}
	const fails = (ledger[branch]?.fails ?? 0) + 1;
	ledger[branch] = { fails, lastDetail: detail.slice(0, 600), at: now };
	file.write(ledger);
	return fails;
}

/**
 * Forced-land audit trail — a force-land is a human override that bypasses the proof gate. It must
 * never be invisible trust: every land that merged WITHOUT a passing proof (forcedWithoutProof) is
 * appended here with the actor + timestamp, so "who force-landed what, unproven, when" is inspectable.
 * Append-only JSON list under <stateDir>; best-effort (a disk failure must never break the land).
 * NO retention guard, deliberately: this is a compliance-auditable record (src/compliance.ts) and
 * must never silently drop.
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

const forced = (stateDir: string) => listFile<ForcedLand>(stateDir, "land-forced.json");

/** Every forced (proof-bypassing) land recorded, oldest first. Corrupt/missing ⇒ empty. */
export function readForcedLands(stateDir: string): ForcedLand[] {
	return forced(stateDir).read();
}

/** Append one forced-land audit record. No-op for an undefined branch. Returns the new record count. */
export function recordForcedLand(stateDir: string, branch: string | undefined, actor: string, detail: string, now = Date.now()): number {
	const file = forced(stateDir);
	if (!branch) return file.read().length;
	return file.append({ branch, actor, detail: detail.slice(0, 600), at: now });
}

/**
 * Validator-override audit trail (Epic 3, leaf 03) — bypassing a validator VETO is a strictly
 * stronger act than a proof-force (a proof-force skips a stale exit-code gate; an override
 * bypasses a semantic judgment that the declared acceptance criteria were NOT met), so it gets its
 * own record type in its own file — never folded into `ForcedLand`/`land-forced.json`. The two
 * override classes must stay separately auditable by the compliance evaluator (src/compliance.ts).
 * Append-only JSON list under <stateDir>; best-effort; NO retention guard (compliance-auditable).
 */
export interface ValidatorOverride {
	/** The branch whose validator veto was overridden. */
	branch: string;
	/** The actor id that overrode it. */
	actor: string;
	/** Required, non-empty reason class (e.g. "criteria-wrong" | "judge-hallucination" | "emergency"). */
	reasonClass: string;
	/** Truncated context — typically the veto's own rationale. */
	detail: string;
	/** ms epoch of the override. */
	at: number;
}

const overrides = (stateDir: string) => listFile<ValidatorOverride>(stateDir, "land-validator-override.json");

/** Every validator-override recorded, oldest first. Corrupt/missing ⇒ empty. */
export function readValidatorOverrides(stateDir: string): ValidatorOverride[] {
	return overrides(stateDir).read();
}

/**
 * Append one validator-override record. Refuses (no write, no-op) when `branch` is undefined OR
 * `reasonClass` is empty/whitespace — an override without a reason class is not recorded and must
 * not be honored (the veto stands). Returns the new record count (or the current count on refusal).
 */
export function recordValidatorOverride(stateDir: string, branch: string | undefined, actor: string, reasonClass: string, detail: string, now = Date.now()): number {
	const file = overrides(stateDir);
	if (!branch || !reasonClass.trim()) return file.read().length;
	return file.append({ branch, actor, reasonClass: reasonClass.trim(), detail: detail.slice(0, 600), at: now });
}
