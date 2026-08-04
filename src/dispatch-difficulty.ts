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
 * GATING STATUS: STILL SHADOW-ONLY, after TWO retreat rounds. Slice 3b built the evidence,
 * the derived action-item rows, and a clear verb — and its blind review (codex, round 2) found
 * five more holes before apply could be honest: the webapp consumer may drop the rows (no
 * rendered control invokes the clear), ?repo= views hide verdicts (no repo on the row), clear
 * is instantly re-starved by a pre-clear in-flight run (needs a generation baseline), the
 * audit lacks prior-verdict/reason, and multi-manager GET/POST bindings mismatch in DB mode.
 * plans/deepen-modules/14 "3b-final" carries that checklist; apply gates NOTHING until it
 * clears. The TIER-pooled telemetry below remains shadow forever regardless.
 *
 * Original slice-1 record — SHIPPED SHADOW-ONLY, deliberately. The blind review (codex, 2026-08-04, three High findings,
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

// ── Per-issue attempt evidence (DESIGN v2, slice 3a) ─────────────────────────────────────────
// The DAPO-faithful unit: the ISSUE's own judged history, which dissolves the class-mismatch
// finding by construction. Written at the SAME single site as recordModelOutcome (judged
// outcomes only — retryable refusals and race "pending" placeholders write nothing), keyed
// runId-idempotent so finalize/terminal double-fire cannot double-bill (grok finding).
// GATING REMAINS UNSHIPPED until 3b lands the rendered surface + audited human clear verb
// (DESIGN v2 points 3–5): verdicts here are shadow-only, like everything else in this module.

import { mapFile } from "./ledger.ts";
import type { IssueRef } from "./types.ts";

export interface IssueAttemptRecord {
	/** Judged attempts (landed or rejected — never blocked/retryable). */
	attempts: number;
	fails: number;
	lastAt: number;
	lastAgentId?: string;
	/** Human-readable issue identifier (e.g. OMPSQ-42), captured at write time for surfaces. */
	identifier?: string;
	/** Idempotency ring: recent runIds that already billed an attempt (bounded, newest last) — a
	 *  repeat of ANY of them is dropped, so A,B,A double-fire never double-bills (codex finding;
	 *  consecutive-only dedup did not survive interleaved finalize/terminal fires). */
	recentRunIds?: string[];
	/** Set by 3b's audited operator clear verb; presence means the starve verdict is acked. */
	clearedBy?: string;
	clearedAt?: number;
}

/** An issue is STARVED at ≥3 judged attempts, all failed (DESIGN: aligns the race-once ladder —
 *  original + raced sibling + one more). */
export const ISSUE_STARVE_ATTEMPTS = 3;

const issueAttempts = (stateDir: string) => mapFile<IssueAttemptRecord>(stateDir, "issue-attempts.json");

// One ledger parse per dispatch tick, not per candidate (codex: O(N×M) JSON on the event loop).
// TTL sits under the dispatcher's poll interval, and every WRITE invalidates the snapshot, so
// there is no read-after-write staleness — the cache only ever elides repeat reads within a tick.
const SNAPSHOT_TTL_MS = 2000;
const snapshotCache = new Map<string, { at: number; data: Record<string, IssueAttemptRecord> }>();

/** Record one judged outcome for an issue. Record-only, never gates, never throws. */
export function recordIssueAttempt(stateDir: string, issueId: string | undefined, runId: string | undefined, ok: boolean, agentId?: string, now = Date.now(), identifier?: string): void {
	if (!issueId) return;
	const file = issueAttempts(stateDir);
	const all = file.read();
	const prior = all[issueId];
	if (runId && prior?.recentRunIds?.includes(runId)) return; // any replay of a billed run: dropped
	const recentRunIds = runId ? [...(prior?.recentRunIds ?? []), runId].slice(-8) : (prior?.recentRunIds ?? []);
	all[issueId] = {
		attempts: (prior?.attempts ?? 0) + 1,
		fails: (prior?.fails ?? 0) + (ok ? 0 : 1),
		lastAt: now,
		...(agentId ? { lastAgentId: agentId } : {}),
		...(identifier ?? prior?.identifier ? { identifier: identifier ?? prior?.identifier } : {}),
		...(recentRunIds.length ? { recentRunIds } : {}),
		// Ack semantics: a prior ack survives only while the issue stays BELOW the starve floor —
		// once fresh failures reach the floor again, the ack drops and the question re-opens.
		...(ok ? {} : prior?.clearedBy && prior.fails + 1 < ISSUE_STARVE_ATTEMPTS ? { clearedBy: prior.clearedBy, clearedAt: prior.clearedAt } : {}),
	};
	file.write(all);
	snapshotCache.delete(stateDir); // a write invalidates the tick snapshot — no read-after-write staleness
}

export function readIssueAttempts(stateDir: string): Record<string, IssueAttemptRecord> {
	return issueAttempts(stateDir).read();
}

function issueAttemptsSnapshot(stateDir: string, now = Date.now()): Record<string, IssueAttemptRecord> {
	const hit = snapshotCache.get(stateDir);
	if (hit && now - hit.at < SNAPSHOT_TTL_MS) return hit.data;
	const data = issueAttempts(stateDir).read();
	snapshotCache.set(stateDir, { at: now, data });
	return data;
}

/** Starved-and-unacked entries, derived fresh from the ledger — the action-items surface and
 *  the dispatcher gate both read THIS, so what renders and what gates can never disagree. */
export function starvedIssues(stateDir: string, now = Date.now()): Array<{ issueId: string; record: IssueAttemptRecord }> {
	void now;
	return Object.entries(readIssueAttempts(stateDir))
		.filter(([, r]) => r.attempts >= ISSUE_STARVE_ATTEMPTS && r.fails === r.attempts && !r.clearedBy)
		.map(([issueId, record]) => ({ issueId, record }));
}

/** The audited operator clear verb (DESIGN v2 point 3): stamps the ack INTO the evidence row —
 *  never deletes history, never touches the dispatch ledger, never implicit. Returns false when
 *  there is nothing to clear (route maps that to 404, not a silent 200). */
export function clearIssueStarvation(stateDir: string, issueId: string, actorId: string, now = Date.now()): boolean {
	const file = mapFile<IssueAttemptRecord>(stateDir, "issue-attempts.json");
	const all = file.read();
	const rec = all[issueId];
	// Only a currently-starved row is clearable (codex round-2): acking a healthy or already
	// acked row is a 404, and the ack is a LOG-SILENCER until 3b-final's generation semantics
	// make it a real gate reset.
	if (!rec || rec.clearedBy || rec.attempts < ISSUE_STARVE_ATTEMPTS || rec.fails !== rec.attempts) return false;
	all[issueId] = { ...rec, clearedBy: actorId, clearedAt: now };
	file.write(all);
	snapshotCache.delete(stateDir);
	return true;
}

/** Per-issue verdict for the dispatcher's `difficultyFor` seam. Always proceeds while
 *  gating is unshipped; the reason carries the starve evidence when present. */
export function issueDifficultyDecision(stateDir: string, issue: Pick<IssueRef, "id" | "identifier">, mode: DifficultyDispatchMode): DifficultyDispatchDecision | undefined {
	if (mode === "off") return undefined;
	const rec = issueAttemptsSnapshot(stateDir)[issue.id];
	if (!rec || rec.attempts < ISSUE_STARVE_ATTEMPTS || rec.fails !== rec.attempts) return undefined; // nothing noteworthy — no log line
	if (rec.clearedBy) return undefined; // acked by the human clear verb; silence until new evidence
	const label = issue.identifier ?? rec.identifier ?? issue.id;
	const evidence = `${rec.fails}/${rec.attempts} judged attempts failed — needs re-scope or a human call, not another unit`;
	// Apply retreated to shadow a SECOND time (module doc "GATING STATUS"): round-2 review found
	// the surface/clear/audit halves not yet honest. Loud refusal, never a silent downgrade.
	const applyNote = mode === "apply" ? "apply requested but gating awaits 3b-final (see module doc GATING STATUS) — running shadow. " : "";
	return { proceed: true, reason: `${applyNote}issue ${label} STARVED (would defer): ${evidence}` };
}
