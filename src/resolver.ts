/**
 * Resolver — failure-routing seam.
 *
 * Maps a run failure to the next action. The default policy escalates every
 * failure to a human; the real self-healing ensemble (#11/#12) replaces
 * `routeFailure` with retry/hold heuristics. Types + default impl only — no
 * behavior is wired into squad-manager yet, so the fleet still escalates.
 */

/** What kind of failure a run hit: a red gate (tests/verify failed) or a merge conflict on land. */
export type FailureKind = "red" | "conflict";

/** Where a failure routes next: re-run it, ask a human, or park it. */
export type FailureRoute = "retry" | "escalate" | "hold";

/** Signals the router may weigh. Opaque to the default policy; the ensemble (#11/#12) reads it. */
export interface FailureContext {
	/** Retries already spent on this unit of work. */
	attempts?: number;
	/** Agent that hit the failure. */
	agentId?: string;
}

/**
 * Default policy: escalate every failure to a human. Deliberately ignores `kind`/`ctx` —
 * the retry/hold heuristics land with the ensemble (#11/#12); this is the seam they replace.
 */
export function routeFailure(kind: FailureKind, ctx?: FailureContext): FailureRoute {
	return "escalate";
}
