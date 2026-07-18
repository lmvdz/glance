/**
 * Plan-vs-reality assembler (OMPSQ-448 feature): for a `plans/<name>/` feature, line up what was
 * PLANNED against what actually got IMPLEMENTED, and tie both to the PROOF that verifies it.
 *
 * This module is a PURE function over already-gathered inputs (parsed concerns, the feature's
 * DoneProof, a reachability verdict, the landed commit's actual changed files, live Plane states) so
 * it is unit-testable without git/Plane/the daemon. `SquadManager.planReality` (squad-manager.ts)
 * gathers the raw inputs and calls `assemblePlanReality`.
 *
 * HONESTY about the data model (see plans + done-proof.ts): the daemon stores no per-concern
 * commit/proof edge. `DoneProof` is ONE record per feature/branch (keyed on branch or Plane issue),
 * and the concern→implementation link is otherwise a live derivation. So:
 *   - Per-concern we report STATUS (Plane-synced) — the reliable "implemented?" signal.
 *   - Proof is reported at the FEATURE level and reflected onto each DONE concern (they share it),
 *     never fabricated per-concern.
 *   - Scope drift compares the union of declared `touches` against the landed commit's REAL changed
 *     files — a genuine, stored-data signal.
 * Every derived/best-effort field is labelled so the UI never presents a guess as a fact.
 */

import { concernNumFromFile, isClosedConcernStatus, type PlanConcern } from "./features.ts";
import type { DoneProof } from "./done-proof.ts";

/** The verified-reality state of a single concern — the "is it REALLY done?" signal. */
export type ConcernRealityState =
	| "open" // not a closed status yet
	| "done-proven" // closed AND the feature has a green/red-baseline proof that is still reachable on the default branch
	| "done-stale" // closed AND proof exists but no longer reaches the default branch (a follow-up rewrote history / it was reverted)
	| "done-unproven"; // closed but the feature carries no landing proof at all

export interface PlanRealityConcernDTO {
	// ── PLANNED ──
	file: string;
	path: string;
	title: string;
	status: string;
	priority?: string;
	complexity?: string;
	planeId?: string;
	open: boolean;
	/** Declared file surface (the plan's INTENT), not what actually changed. */
	touches: string[];
	prerequisites: string[];
	/** True when this open concern depends on a sibling concern that is not yet closed. */
	blocked: boolean;
	// ── IMPLEMENTED ──
	/** Live Plane state group name for this concern's ticket, when a `PLANE:` id is present and resolvable. */
	planeState?: string;
	// ── PROOF (reflected from the feature-level proof onto each DONE concern) ──
	realityState: ConcernRealityState;
}

/** Feature-level landing proof, plus a live reachability verdict. */
export interface PlanRealityProofDTO {
	present: boolean;
	verified?: DoneProof["verified"];
	mode?: DoneProof["mode"];
	commit?: string;
	mergeCommit?: string;
	baseRef?: string;
	prNumber?: number;
	prUrl?: string;
	provenAt?: number;
	/** true = the proven commit still reaches the default branch; false = stale; null = couldn't determine. */
	reachable: boolean | null;
	/** One-line human reason for `reachable` (e.g. "on origin/main", "stale — not an ancestor of origin/main"). */
	reachableDetail: string;
}

export interface PlanRealityRollupDTO {
	totalConcerns: number;
	done: number;
	open: number;
	blocked: number;
	/** done concerns that are backed by a present, still-reachable proof (the "really done" count). */
	doneProven: number;
	/** done concerns whose only backing proof is stale (history moved past it). */
	doneStale: number;
	/** done concerns with no landing proof at all. */
	doneUnproven: number;
	proofPresent: boolean;
	proofReachable: boolean | null;
	scopeDrift: {
		/** Distinct files the plan DECLARED it would touch (union of every concern's `touches`). */
		plannedTouches: number;
		/** Distinct files the landed commit ACTUALLY changed — null when it couldn't be computed. */
		actualChangedFiles: number | null;
		/** Declared-but-untouched: planned files that never appear in the actual diff (undelivered surface). */
		plannedNotTouched: string[];
		/** Touched-but-unplanned: files the landing changed that no concern declared (scope creep). */
		touchedNotPlanned: string[];
	};
}

export interface PlanRealityDTO {
	featureId: string;
	title: string;
	repo: string;
	planDir?: string;
	concerns: PlanRealityConcernDTO[];
	proof: PlanRealityProofDTO;
	rollup: PlanRealityRollupDTO;
	/** Files the landed commit actually changed, when computable (drives the scope-drift diff). */
	actualChangedFiles: string[] | null;
	generatedAt: number;
}

export interface PlanRealityInputs {
	feature: { id: string; title: string; repo: string; planDir?: string };
	concerns: PlanConcern[];
	proof?: DoneProof;
	/** true = proof commit still reaches the default branch; false = stale; null/undefined = unknown. */
	proofReachable?: boolean | null;
	/** The reason string for the reachability verdict (from the git check). */
	reachableDetail?: string;
	/** Files the landed commit actually changed (from `git diff --name-only base..commit`); null if uncomputable. */
	actualChangedFiles?: string[] | null;
	/** planeId → live Plane state group name, when resolved. */
	planeStates?: Record<string, string>;
	now: number;
}

/** Leading NN of the concerns a given concern is blocked by, parsed from its `prerequisites` strings. */
function blockedByNums(prerequisites: string[]): number[] {
	const nums: number[] = [];
	for (const p of prerequisites) {
		// "Blocked by 03", "depends on 02 and 05", "after 04" — pull every standalone 1-3 digit token.
		for (const m of p.matchAll(/\b(\d{1,3})\b/g)) {
			const n = Number(m[1]);
			if (Number.isFinite(n)) nums.push(n);
		}
	}
	return nums;
}

export function assemblePlanReality(inputs: PlanRealityInputs): PlanRealityDTO {
	const { feature, concerns, proof, planeStates, now } = inputs;
	const proofReachable = inputs.proofReachable ?? null;
	const actualChangedFiles = inputs.actualChangedFiles ?? null;

	// Concern number → is-closed, for blocked-by resolution.
	const closedByNum = new Map<number, boolean>();
	for (const c of concerns) {
		const n = concernNumFromFile(c.file);
		if (n !== null) closedByNum.set(n, isClosedConcernStatus(c.status));
	}

	const proofPresent = !!proof;
	// A concern's reality state: closed concerns inherit the feature's proof verdict (there is no
	// per-concern proof in the data model — see module doc). Open concerns are just "open".
	const concernRealityState = (c: PlanConcern): ConcernRealityState => {
		if (!isClosedConcernStatus(c.status)) return "open";
		if (!proofPresent) return "done-unproven";
		if (proofReachable === false) return "done-stale";
		return "done-proven"; // reachable true OR unknown ⇒ we have a proof; treat unknown-reachability as proven-but-flag at feature level
	};

	const outConcerns: PlanRealityConcernDTO[] = concerns.map((c) => {
		const deps = blockedByNums(c.prerequisites);
		const blocked = !isClosedConcernStatus(c.status) && deps.some((n) => closedByNum.get(n) === false);
		return {
			file: c.file,
			path: c.path,
			title: c.title,
			status: c.status,
			priority: c.priority,
			complexity: c.complexity,
			planeId: c.planeId,
			open: c.open,
			touches: c.touches,
			prerequisites: c.prerequisites,
			blocked,
			planeState: c.planeId ? planeStates?.[c.planeId] : undefined,
			realityState: concernRealityState(c),
		};
	});

	const done = outConcerns.filter((c) => !c.open).length;
	const doneProven = outConcerns.filter((c) => c.realityState === "done-proven").length;
	const doneStale = outConcerns.filter((c) => c.realityState === "done-stale").length;
	const doneUnproven = outConcerns.filter((c) => c.realityState === "done-unproven").length;
	const blocked = outConcerns.filter((c) => c.blocked).length;

	const plannedTouchesSet = new Set<string>();
	for (const c of concerns) for (const t of c.touches) if (t.trim()) plannedTouchesSet.add(t.trim());
	const actualSet = actualChangedFiles ? new Set(actualChangedFiles) : null;
	// Scope drift: planned-not-touched and touched-not-planned are only meaningful when we have the
	// actual diff. `touches` are declared paths (may be dirs or globs), so match by prefix/substring
	// leniency: a planned entry is "touched" if any actual file starts with it (dir) or equals it.
	const plannedNotTouched: string[] = [];
	const touchedNotPlanned: string[] = [];
	if (actualSet) {
		for (const planned of plannedTouchesSet) {
			const hit = [...actualSet].some((f) => f === planned || f.startsWith(planned.endsWith("/") ? planned : `${planned}/`));
			if (!hit) plannedNotTouched.push(planned);
		}
		for (const actual of actualSet) {
			const hit = [...plannedTouchesSet].some((p) => actual === p || actual.startsWith(p.endsWith("/") ? p : `${p}/`));
			if (!hit) touchedNotPlanned.push(actual);
		}
	}

	const rollup: PlanRealityRollupDTO = {
		totalConcerns: outConcerns.length,
		done,
		open: outConcerns.length - done,
		blocked,
		doneProven,
		doneStale,
		doneUnproven,
		proofPresent,
		proofReachable,
		scopeDrift: {
			plannedTouches: plannedTouchesSet.size,
			actualChangedFiles: actualSet ? actualSet.size : null,
			plannedNotTouched: plannedNotTouched.sort(),
			touchedNotPlanned: touchedNotPlanned.sort(),
		},
	};

	const proofDto: PlanRealityProofDTO = {
		present: proofPresent,
		verified: proof?.verified,
		mode: proof?.mode,
		commit: proof?.commit,
		mergeCommit: proof?.mergeCommit,
		baseRef: proof?.baseRef,
		prNumber: proof?.prNumber,
		prUrl: proof?.prUrl,
		provenAt: proof?.provenAt,
		reachable: proofPresent ? proofReachable : null,
		reachableDetail: !proofPresent ? "no landing proof recorded for this plan" : (inputs.reachableDetail ?? (proofReachable === null ? "reachability unknown" : proofReachable ? "on the default branch" : "stale — no longer on the default branch")),
	};

	return {
		featureId: feature.id,
		title: feature.title,
		repo: feature.repo,
		planDir: feature.planDir,
		concerns: outConcerns,
		proof: proofDto,
		rollup,
		actualChangedFiles,
		generatedAt: now,
	};
}
