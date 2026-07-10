/**
 * Shared fail-closed taxonomy for the wave-1 sweep (plans/eap-borrows/04-fail-closed-wave-1.md,
 * failopen-sweep.md findings #7/#12/#15/#16). Every site this feeds shared the SAME pathology
 * before this fix: a checker that could not produce a real verdict (a thrown gate, a corrupt
 * sidecar, a spawn death, unparseable output) silently read as "safe"/"green"/"baseline" instead
 * of surfacing the fact that nothing was actually verified. One taxonomy keeps the reasoning —
 * and the reason TEXT a human eventually reads — consistent across land-risk.ts, observer.ts,
 * convergence-run.ts, and convergence-oracle.ts rather than four independently-worded escalations.
 *
 * STRUCTURAL failures (corrupt-state, unparseable, missing-command) escalate immediately and are
 * NEVER bare-retryable on their own: retrying doesn't make a corrupt JSON file less corrupt or a
 * deleted binary reappear. Only "spawn-error" (a bare exec/probe failure with no other diagnosis)
 * may be retried, and only when the CALLER supplies its own bounded attempt budget — absent a
 * budget, a spawn-error escalates on the very first failure too, same as a structural one.
 */

export type ProbeFailureKind =
	| "spawn-error" // the checker's own process/exec failed to start, was killed, or a probe command errored
	| "unparseable" // it ran to completion but the output could not be classified into a real verdict
	| "corrupt-state" // a persisted state/sidecar file exists but failed to parse
	| "missing-command"; // a command/binary the checker depends on previously existed and is now gone

export interface ProbeFailureInput {
	kind: ProbeFailureKind;
	/** Human-readable specifics (the underlying error message or gate output) folded into `reason`. */
	detail: string;
	/** 1-based count of this attempt, when the caller tracks one. Ignored unless `maxAttempts` is set. */
	attempt?: number;
	/** The caller's OWN bounded retry budget for this exact probe (e.g. a confirm-then-report
	 *  double-run, or a fixed number of scheduler ticks). Absent/0 ⇒ no budget ⇒ this call IS the
	 *  final attempt, regardless of `kind`. */
	maxAttempts?: number;
}

export interface ProbeFailureClassification {
	/** Safe for an EXISTING bounded-retry mechanism to try again without escalating yet. */
	retryable: boolean;
	/** Must surface to a human (file a finding, block a land, refuse to re-baseline) — never
	 *  silently proceed as though the probe had succeeded. */
	escalate: boolean;
	/** `"<kind>: <detail>"`, with a retry/exhaustion suffix when a budget was supplied. */
	reason: string;
}

const STRUCTURAL: ReadonlySet<ProbeFailureKind> = new Set(["corrupt-state", "unparseable", "missing-command"]);

/** Classify a probe/checker failure into retryable-or-not + escalate-or-not + a stable reason string. */
export function classifyProbeFailure(input: ProbeFailureInput): ProbeFailureClassification {
	if (STRUCTURAL.has(input.kind)) {
		return { retryable: false, escalate: true, reason: `${input.kind}: ${input.detail}` };
	}
	// Only "spawn-error" reaches here — transient by nature, but still fail-closed absent a budget.
	const budget = input.maxAttempts ?? 0;
	const attempt = input.attempt ?? 1;
	const hasBudget = budget > 0 && attempt < budget;
	const reason = hasBudget
		? `${input.kind}: ${input.detail} (attempt ${attempt}/${budget}, retrying)`
		: `${input.kind}: ${input.detail}${budget > 0 ? " (attempt budget exhausted)" : ""}`;
	return { retryable: hasBudget, escalate: !hasBudget, reason };
}
