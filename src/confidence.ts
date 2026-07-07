/**
 * Epic 5 (HITL safeguards) — deterministic run-end confidence score.
 *
 * Pure function of signals already on the record at `finalizeRun` time
 * (`squad-manager.ts`): the deterministic proof state and the blast-radius proxy
 * (files touched). An optional validator signal folds in when present (Epic 3's
 * independent-validator verdict) but is NEVER required — absence is neutral, never
 * a penalty (the "absence = unknown" rule DESIGN.md D1 mandates).
 *
 * The weights below ARE the decision (DESIGN.md §D1) — do not re-tune them here.
 * Threshold tuning based on real outcomes is Epic 6's job, not this file's.
 */

import type { VerificationState } from "./autonomy.ts";
import type { ValidationRecord } from "./types.ts";

export interface ConfidenceInput {
	verificationState: VerificationState;
	filesTouched: number;
	/** Epic 3 independent-validator verdict, when available. Absent ⇒ neutral (no penalty, no bonus). */
	validator?: "pass" | "fail";
	/** Cross-lineage review (plans/cross-lineage-review/): true when the judge shared the author's
	 *  vendor lineage — a self-graded pass is worth LESS. Absent/undefined ⇒ unchanged behavior. */
	sameLineage?: boolean;
	/** Perspective-diversified review (plans/perspective-diversified-review/): advisory out-of-criteria
	 *  lens outcome. "clean" = lenses ran and all accepted; "objected" = at least one objection; "confirmed"
	 *  = a high-severity objection survived its re-check. Absent ⇒ neutral. All deltas are SMALLER in
	 *  magnitude than the primary validator's — advisory, never authoritative. */
	lensAdvisory?: "clean" | "objected" | "confirmed";
}

/** Collapse a validation record's lens fields into the single confidence bucket. Absent/empty ⇒ neutral
 *  (undefined), preserving the "absence = unknown, never penalize" doctrine. A confirmed high-severity
 *  objection outranks a plain objection; all-accept ⇒ "clean". */
export function lensAdvisoryBucket(v?: ValidationRecord): "clean" | "objected" | "confirmed" | undefined {
	const lenses = v?.lensAdvisory;
	if (!lenses || lenses.length === 0) return undefined;
	if (v?.lensVerify?.confirmed) return "confirmed";
	if (lenses.some((l) => l.disposition === "object")) return "objected";
	return "clean";
}

/** Deterministic, clamped [0,1] run-end self-confidence. See DESIGN.md §D1 for the formula. */
export function scoreConfidence(input: ConfidenceInput): number {
	let score = 0.5;

	if (input.verificationState === "fresh") score += 0.3;
	else if (input.verificationState === "stale") score += 0;
	else score -= 0.3; // failed | none | unknown

	if (input.filesTouched <= 3) score += 0.1;
	else if (input.filesTouched > 12) score -= 0.2;

	// A same-lineage (self-graded) pass counts for less — the reviewer shared the author's blind spots
	// (plans/cross-lineage-review/). A veto stays -0.4 regardless: bad news isn't softened by who found it.
	if (input.validator === "pass") score += input.sameLineage === true ? 0.05 : 0.1;
	else if (input.validator === "fail") score -= 0.4;

	// Advisory out-of-criteria lens (plans/perspective-diversified-review/). Deltas are deliberately
	// smaller than the primary validator's ±0.1/−0.4 — this axis nudges, it never decides. The clamp
	// below keeps stacked deltas (e.g. same-lineage bonus + a lens penalty) inside [0,1].
	if (input.lensAdvisory === "clean") score += 0.05;
	else if (input.lensAdvisory === "objected") score -= 0.15;
	else if (input.lensAdvisory === "confirmed") score -= 0.25;

	return Math.max(0, Math.min(1, score));
}
