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

export interface ConfidenceInput {
	verificationState: VerificationState;
	filesTouched: number;
	/** Epic 3 independent-validator verdict, when available. Absent ⇒ neutral (no penalty, no bonus). */
	validator?: "pass" | "fail";
	/** Cross-lineage review (plans/cross-lineage-review/): true when the judge shared the author's
	 *  vendor lineage — a self-graded pass is worth LESS. Absent/undefined ⇒ unchanged behavior. */
	sameLineage?: boolean;
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

	return Math.max(0, Math.min(1, score));
}
