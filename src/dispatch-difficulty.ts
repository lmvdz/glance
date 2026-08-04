/**
 * Difficulty-targeted dispatch (CS329A borrow #1, plans/deepen-modules/14 — DAPO's dynamic
 * sampling / Absolute-Zero's proposer reward, one shared fact): work that always fails carries
 * zero learning signal, and compute spent re-dispatching into it is pure waste — the fleet's
 * logged escalate-cap burn is this failure mode live. The counterpart (all-pass work wastes
 * verify budget) is slice 2; this module gates only the RE-DISPATCH side.
 *
 * The evidence is the EXISTING model-outcomes ledger (landed/rejected per model::tier —
 * `blocked` deliberately excluded: an environmental refusal is not difficulty evidence, the
 * field's own doc says a dirty main is not the model's fault). The work class is the TIER,
 * pooled across model families: the model split is model-route's job; difficulty asks "does
 * this SIZE of work ever land here at all".
 *
 * SHIPPED SHADOW-ONLY, deliberately. The blind review (codex, 2026-08-04, three High findings,
 * all survived adjudication) showed the cheap gating version is wrong:
 *   1. class mismatch — this gate can only key tierOf(undefined)="mid" pre-spawn, but
 *      routeIntake assigns per-issue thinking downstream, so outcomes land in light/heavy while
 *      the gate reads mid (a typo task blocked by unrelated mid failures);
 *   2. family pooling defeats the escalation ladder — four sonnet failures would block a class
 *      that model-route would have escalated to opus, which has no evidence yet;
 *   3. deferral starves — a deferred class generates no new evidence, so an all-fail verdict
 *      can never clear itself, and the promised "escalate or re-scope instead" verb does not
 *      exist yet.
 * Until the gating redesign (per-issue attempt evidence, family-aware classes, a real
 * escalation action — plans/deepen-modules/14's open design questions) lands, an operator
 * `1`/`apply` is answered with a logged refusal and shadow behavior — explicit, never a silent
 * downgrade. `0`/`off` disables even the shadow log. Honesty rules carried from the horizon
 * curve: the verdict states its n, and below the evidence floor it is "insufficient-evidence".
 */
import { tierOf, type ComplexityTier, type ModelOutcomes } from "./model-outcomes.ts";
import type { ThinkingLevel } from "./types.ts";

export type DifficultySignal = "all-fail" | "all-pass" | "mixed" | "insufficient-evidence";

export interface DifficultyVerdict {
	signal: DifficultySignal;
	tier: ComplexityTier;
	/** Judged attempts behind the signal (landed + rejected, pooled across families). */
	attempts: number;
	landed: number;
}

/** An all-fail/all-pass call needs at least this many judged attempts in the class. */
export const DIFFICULTY_MIN_ATTEMPTS = 4;

/** Pool judged outcomes for one tier across every model family in the ledger. */
export function tierDifficulty(outcomes: ModelOutcomes, tier: ComplexityTier, minAttempts = DIFFICULTY_MIN_ATTEMPTS): DifficultyVerdict {
	let landed = 0;
	let attempts = 0;
	for (const [key, counts] of Object.entries(outcomes)) {
		if (!key.endsWith(`::${tier}`)) continue;
		landed += counts.landed;
		attempts += counts.landed + counts.rejected;
	}
	const signal: DifficultySignal =
		attempts < minAttempts ? "insufficient-evidence" : landed === 0 ? "all-fail" : landed === attempts ? "all-pass" : "mixed";
	return { signal, tier, attempts, landed };
}

export type DifficultyDispatchMode = "off" | "shadow" | "apply";

/** `OMP_SQUAD_DIFFICULTY_DISPATCH`: unset/`shadow` ⇒ shadow, `1`/`apply` ⇒ apply, `0`/`off` ⇒ off. */
export function difficultyDispatchMode(raw = process.env.OMP_SQUAD_DIFFICULTY_DISPATCH): DifficultyDispatchMode {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "1" || v === "apply") return "apply";
	if (v === "0" || v === "off") return "off";
	return "shadow";
}

export interface DifficultyDispatchDecision {
	/** Always true while gating is unshipped (module doc); the field exists so the dispatcher's
	 *  defer seam is already honored the day the redesigned gate can return false. */
	proceed: boolean;
	/** Always populated — the audit line, logged on transitions in every mode but off. */
	reason: string;
}

/**
 * The dispatch-time decision for a prospective unit. `thinking` is whatever the spawn would
 * use (the same `tierOf` derivation the outcome WRITE will key on, so the gate and the ledger
 * agree on the class).
 */
export function difficultyDispatchDecision(
	outcomes: ModelOutcomes,
	thinking: ThinkingLevel | undefined,
	mode: DifficultyDispatchMode,
): DifficultyDispatchDecision {
	if (mode === "off") return { proceed: true, reason: "difficulty-dispatch off" };
	const verdict = tierDifficulty(outcomes, tierOf(thinking));
	// Gating is deliberately unshipped (module doc: three survived review findings). An explicit
	// apply request is refused LOUDLY — the reason says so — never silently downgraded.
	const applyNote = mode === "apply" ? "apply requested but gating is unshipped (see dispatch-difficulty.ts module doc) — running shadow. " : "";
	if (verdict.signal !== "all-fail") {
		return { proceed: true, reason: `${applyNote}difficulty ${verdict.tier}: ${verdict.signal} (${verdict.landed}/${verdict.attempts})` };
	}
	return { proceed: true, reason: `${applyNote}difficulty SHADOW (would skip): tier "${verdict.tier}" has landed 0 of ${verdict.attempts} judged attempts — signal-free compute; the redesign owes this class an escalation verb` };
}
