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
 * GATING STATUS (final): PER-ISSUE apply is REAL as of 3b-final (iteration 21) — the checklist
 * that two retreat rounds demanded is complete: rendered control on a live surface, audited
 * generation-resetting clears, repo scoping, org binding by construction. The history below is
 * kept because the retreats are the story of how the gate earned honesty.
 *
 * Prior status — STILL SHADOW-ONLY, after TWO retreat rounds. Slice 3b built the evidence,
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
	/** Repo the attempts ran in, captured at write time — 3b-final item 2: repo-filtered surfaces
	 *  filter by equality instead of hiding every verdict. */
	repo?: string;
	/** Idempotency ring: recent runIds that already billed an attempt (bounded, newest last) — a
	 *  repeat of ANY of them is dropped, so A,B,A double-fire never double-bills (codex finding;
	 *  consecutive-only dedup did not survive interleaved finalize/terminal fires). */
	recentRunIds?: string[];
	/** Set by the audited operator clear verb; presence means the starve verdict is acked. */
	clearedBy?: string;
	clearedAt?: number;
	/** Generation watermarks (3b-final item 3): the counters AT clear time. The starve predicate
	 *  runs on post-clear evidence only (attempts-attemptsAtClear / fails-failsAtClear), and a run
	 *  STARTED before the clear bills the old generation — both raw and watermark move together,
	 *  so pre-clear stragglers can never re-starve the fresh generation. */
	attemptsAtClear?: number;
	failsAtClear?: number;
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
export function recordIssueAttempt(stateDir: string, issueId: string | undefined, runId: string | undefined, ok: boolean, agentId?: string, now = Date.now(), identifier?: string, opts?: { repo?: string; runStartedAt?: number }): void {
	if (!issueId) return;
	const file = issueAttempts(stateDir);
	const all = file.read();
	const prior = all[issueId];
	if (runId && prior?.recentRunIds?.includes(runId)) return; // any replay of a billed run: dropped
	const recentRunIds = runId ? [...(prior?.recentRunIds ?? []), runId].slice(-8) : (prior?.recentRunIds ?? []);
	// Generation billing (3b-final item 3): a run that STARTED before the operator's clear bills
	// the old generation — raw counters and watermarks move together so post-clear evidence stays
	// exactly the runs the operator's decision could not have known about.
	const oldGeneration = prior?.clearedAt !== undefined && opts?.runStartedAt !== undefined && opts.runStartedAt < prior.clearedAt;
	const attempts = (prior?.attempts ?? 0) + 1;
	const fails = (prior?.fails ?? 0) + (ok ? 0 : 1);
	const cleared = prior?.clearedBy
		? {
				clearedBy: prior.clearedBy,
				clearedAt: prior.clearedAt,
				attemptsAtClear: (prior.attemptsAtClear ?? prior.attempts) + (oldGeneration ? 1 : 0),
				failsAtClear: (prior.failsAtClear ?? prior.fails) + (oldGeneration && !ok ? 1 : 0),
			}
		: {};
	all[issueId] = {
		attempts,
		fails,
		lastAt: now,
		...(agentId ? { lastAgentId: agentId } : {}),
		...(identifier ?? prior?.identifier ? { identifier: identifier ?? prior?.identifier } : {}),
		...(opts?.repo ?? prior?.repo ? { repo: opts?.repo ?? prior?.repo } : {}),
		...(recentRunIds.length ? { recentRunIds } : {}),
		...cleared,
	};
	file.write(all);
	snapshotCache.delete(stateDir); // a write invalidates the tick snapshot — no read-after-write staleness
}

/** Compensating restore for a failed clear-audit (atomicity by compensation — the clear must
 *  not survive an unaudited write; see SquadManager.clearIssueStarvationVerdict). */
export function restoreIssueAttemptRecord(stateDir: string, issueId: string, record: IssueAttemptRecord): void {
	const file = mapFile<IssueAttemptRecord>(stateDir, "issue-attempts.json");
	const all = file.read();
	all[issueId] = record;
	file.write(all);
	snapshotCache.delete(stateDir);
}

/** Post-clear (current-generation) evidence for one row. */
export function effectiveEvidence(r: IssueAttemptRecord): { attempts: number; fails: number } {
	if (!r.clearedBy) return { attempts: r.attempts, fails: r.fails };
	return { attempts: r.attempts - (r.attemptsAtClear ?? r.attempts), fails: r.fails - (r.failsAtClear ?? r.fails) };
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
		.filter(([, r]) => {
			const e = effectiveEvidence(r);
			return e.attempts >= ISSUE_STARVE_ATTEMPTS && e.fails === e.attempts && e.attempts > 0;
		})
		.map(([issueId, record]) => ({ issueId, record }));
}

/** The audited operator clear verb (DESIGN v2 point 3): stamps the ack INTO the evidence row —
 *  never deletes history, never touches the dispatch ledger, never implicit. Returns false when
 *  there is nothing to clear (route maps that to 404, not a silent 200). */
export function clearIssueStarvation(stateDir: string, issueId: string, actorId: string, now = Date.now()): { prior: IssueAttemptRecord } | undefined {
	const file = mapFile<IssueAttemptRecord>(stateDir, "issue-attempts.json");
	const all = file.read();
	const rec = all[issueId];
	// Only a currently-starved row (on its CURRENT generation) is clearable: acking a healthy or
	// already-acked row is a 404. The clear starts a fresh generation via the watermarks — the
	// starve predicate sees only post-clear evidence, and pre-clear in-flight runs bill the old
	// generation (see recordIssueAttempt) — 3b-final item 3.
	if (!rec) return undefined;
	const e = effectiveEvidence(rec);
	if (e.attempts < ISSUE_STARVE_ATTEMPTS || e.fails !== e.attempts || e.attempts === 0) return undefined;
	all[issueId] = { ...rec, clearedBy: actorId, clearedAt: now, attemptsAtClear: rec.attempts, failsAtClear: rec.fails };
	file.write(all);
	snapshotCache.delete(stateDir);
	return { prior: rec };
}

/** Per-issue verdict for the dispatcher's `difficultyFor` seam. Always proceeds while
 *  gating is unshipped; the reason carries the starve evidence when present. */
export function issueDifficultyDecision(stateDir: string, issue: Pick<IssueRef, "id" | "identifier">, mode: DifficultyDispatchMode): DifficultyDispatchDecision | undefined {
	if (mode === "off") return undefined;
	const rec = issueAttemptsSnapshot(stateDir)[issue.id];
	if (!rec) return undefined;
	const e = effectiveEvidence(rec);
	if (e.attempts < ISSUE_STARVE_ATTEMPTS || e.fails !== e.attempts || e.attempts === 0) return undefined; // nothing noteworthy on the CURRENT generation
	const label = issue.identifier ?? rec.identifier ?? issue.id;
	const evidence = `${e.fails}/${e.attempts} judged attempts failed — needs re-scope or a human call, not another unit`;
	// PER-ISSUE apply is REAL (3b-final complete, iteration 21): the verdict renders on a LIVE
	// surface (MondaySurface via GET /api/issues/starved) with a control invoking the audited
	// clear; generations make the clear a true reset; repo scoping and org binding hold. The
	// tier-telemetry dep remains shadow forever.
	if (mode === "apply") return { proceed: false, reason: `issue ${label} STARVED (deferred): ${evidence}. Clear via the fleet surface or POST /api/issues/${issue.id}/redispatch.` };
	return { proceed: true, reason: `issue ${label} STARVED (would defer): ${evidence}` };
}
