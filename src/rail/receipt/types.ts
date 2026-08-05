/**
 * The land-receipt data model (glance#334, rail T6) — the self-contained facts a human needs to
 * approve a land WITHOUT reading the diff. This is the boundary object between the land path (which
 * PRODUCES these facts) and the receipt renderer (which is pure and only READS them): assembling a
 * `LandReceipt` is the only place that touches the live land outputs, so `render-html.ts` /
 * `render-comment.ts` stay pure and golden-testable.
 *
 * Every field is designed around ONE of the five questions a land approver asks cold:
 *   1. WHAT landed        → repo/branch/commit/files/insertions/deletions/landed
 *   2. WHAT PROVED IT     → gate.{status, unprovenGreenRejected, newRegressions, baseWasRed}
 *   3. WHO REVIEWED IT    → validation (T4's reviewerPrecision) + panel (T5, parked)
 *   4. ROLLBACK POINT     → rollbackPoint (head0) + forcedWithoutProof
 *   5. COST               → cost.{costUsd, costUnknown, model, tokens}
 *
 * Honesty is the whole point of the surface, so the shape refuses to lie:
 *   - `cost.costUnknown` is a FIRST-CLASS flag, distinct from `costUsd === 0`. A run whose usage was
 *     never observed (RunReceipt.costUsd absent) is `costUnknown: true` and renders "cost
 *     unattributed" — NEVER "$0.00", which would falsely assert a measured-free run. A genuinely
 *     free run (measured, 0) is `costUnknown: false, costUsd: 0`. (Note: the base branch has no
 *     `costUnknown` field on RunReceipt — the T8 wording in the ticket was aspirational; the honest
 *     mapping is "costUsd absent ⇒ unattributed", computed in the assembler.)
 *   - `validation.reviewerPrecision` (T4) is rendered through the SAME honesty rules the ledger reader
 *     enforces (n=0 ⇒ "unmeasured", unreadable/corrupt ledgers ⇒ their own reasons) — never a
 *     fabricated or smoothed number.
 */

import type { ValidationRecord } from "../../types.ts";
import type { ReviewerPrecisionStamp } from "../../memory/index.ts";

/**
 * One panelist's verdict in a multi-reviewer panel (rail T5, glance#356 — PARKED). Defined here, not
 * yet on `ValidationRecord`, so the receipt renders a panel section the MOMENT a ValidationRecord
 * carries one, with no follow-up change to this surface. `readPanel()` (render-html.ts) reads it via a
 * forward-compatible optional accessor; when T5 lands `panel?: PanelVerdict[]` on ValidationRecord the
 * field simply flows through.
 */
export interface PanelVerdict {
	/** Reviewer identity / lineage, e.g. "grok-4.5", "codex". */
	reviewer: string;
	verdict: "approve" | "object" | "abstain";
	/** The reviewer's measured precision, if the panel carried one. Rendered with the same honesty rules. */
	precision?: ReviewerPrecisionStamp;
	/** One-line rationale for an objection; truncated for the receipt. */
	note?: string;
}

/**
 * The land's proof outcome, distilled to a single trusted state. The HTML encodes it in FORM (a green
 * banner vs a red one), not just in a word — an honest state a human reads at a glance.
 *   - "green"             acceptance + regression gates passed on a green base; a clean land.
 *   - "red-baseline"      base was already red; the branch introduced NO new failure, so it landed —
 *                         but main is honestly NOT green (amber, not green).
 *   - "failed"            a gate failed / new regressions were introduced; nothing landed (or it was
 *                         rolled back to the rollback point). RED.
 *   - "unproven-rejected" a green EXIT that could not be trusted (degraded sandbox / zero tests) was
 *                         refused and main rolled back. RED — an untrusted pass is not a pass.
 *   - "no-gate"           no acceptance gate was configured; the land is recorded but nothing proved
 *                         it. AMBER.
 *   - "forced"            merged WITHOUT a passing proof — a human override. AMBER, and always paired
 *                         with `forcedWithoutProof: true`.
 */
export type GateStatus = "green" | "red-baseline" | "failed" | "unproven-rejected" | "no-gate" | "forced";

export interface LandReceiptGate {
	status: GateStatus;
	/** The acceptance-gate command, when the land recorded one (e.g. "bun run check"). */
	command?: string;
	/** A green-but-untrusted acceptance pass was rejected and main rolled back. */
	unprovenGreenRejected: boolean;
	/** Strictly-NEW failures the branch introduced vs the baseline failure set — the failure-set diff.
	 *  Empty on a clean land; itemized when the land's own detail listed them. */
	newRegressions: string[];
	/** The base was already red (a red-baseline land, or a red-baseline diff comparison). */
	baseWasRed: boolean;
	/** The land's own honest detail line, truncated. What the gate actually said. */
	detail?: string;
}

export interface LandReceiptCost {
	/** Measured cost in USD. May be a real 0 (a genuinely free run) — distinguish via `costUnknown`. */
	costUsd?: number;
	/** True when NO assistant usage was observed for the run — cost is unattributed, NOT zero. The
	 *  renderer shows "cost unattributed" and never "$0.00" for this case. */
	costUnknown: boolean;
	/** Effective model the run actually used, when known. */
	model?: string;
	/** Total tokens across the run, when observed. */
	tokens?: number;
}

/**
 * The complete, self-contained facts of one land. Everything the renderer needs; nothing it has to
 * reach back into the daemon for.
 */
export interface LandReceipt {
	// ── 1. WHAT landed ────────────────────────────────────────────────────────────────────────────
	/** "owner/repo" slug (or the repo identity when a slug can't be resolved). */
	repo: string;
	branch: string;
	/** The landed commit SHA (full). Absent when nothing merged (a rejected land). */
	commit?: string;
	/** Files the change touched (base-relative). */
	files: string[];
	insertions?: number;
	deletions?: number;
	/** True when the change actually merged into main. */
	landed: boolean;
	/** Epoch ms the land resolved. */
	at: number;

	// ── 2. WHAT PROVED IT ─────────────────────────────────────────────────────────────────────────
	gate: LandReceiptGate;

	// ── 3. WHO REVIEWED IT ────────────────────────────────────────────────────────────────────────
	/** The independent validator's record — carries T4's `reviewerPrecision` stamp. Absent when no
	 *  validator ran (e.g. the no-criteria / skipped path). */
	validation?: ValidationRecord;
	/** Multi-reviewer panel (T5, parked). Rendered iff present; omitted gracefully otherwise. */
	panel?: PanelVerdict[];

	// ── 4. ROLLBACK POINT ─────────────────────────────────────────────────────────────────────────
	/** The commit main would return to if this land were reverted (head0). Absent when nothing merged. */
	rollbackPoint?: string;
	/** Merged WITHOUT a passing proof gate — a human override made legible. */
	forcedWithoutProof: boolean;

	// ── 5. COST ───────────────────────────────────────────────────────────────────────────────────
	cost: LandReceiptCost;
}
