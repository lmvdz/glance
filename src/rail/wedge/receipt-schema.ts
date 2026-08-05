/**
 * Runtime validation for a `LandReceipt` read from an UNTRUSTED source (glance#337, rail T9 gauntlet
 * round 1, both lineages CRITICAL: `postAgentPrCheck` was greening a required check on the mere
 * truthiness of a receipt OBJECT — no shape check, no binding to the PR it's supposedly proof for).
 *
 * This is the schema the CLI (scripts/post-wedge-check.ts) decodes an operator-supplied `--receipt`
 * JSON file through — replacing the bare parsed-and-cast read the gauntlet flagged (not spelled out
 * verbatim here; the ratchet scan is line-regex based — see err-text.ts's note).
 * A receipt originating INSIDE the daemon's own land pipeline is already a real `LandReceipt` (built
 * by `classifyLand`/the land path, never round-tripped through JSON) and doesn't need re-decoding —
 * but `receipt-verify.ts`'s policy checks (repo/SHA/gate-outcome/freshness) apply to EVERY receipt
 * regardless of origin, because a wrongly-typed value was never the only way to get this wrong (a
 * well-typed receipt for the WRONG PR is just as dangerous, and shape validation can't catch that).
 *
 * `validation`/`panel` model only the fields `render-comment.ts` actually reads (`verdict`,
 * `rationale`, `model`, `perCriterion`, `reviewerPrecision` / `reviewer`, `precision`, `note`) —
 * `ValidationRecord`'s `lensAdvisory`/`lensVerify`/`gateLogPaths` are optional-and-unread by the
 * receipt surface, so `Schema.Struct` (which strips rather than rejects unlisted keys, per
 * channel-card.ts's own note) omitting them is sound: those fields stay optional on the real
 * `ValidationRecord` interface, so a decoded value missing them is still structurally assignable.
 */
import { Schema } from "effect";
import type { LandReceipt } from "../receipt/types.ts";

const GateStatusSchema = Schema.Literals(["green", "red-baseline", "failed", "unproven-rejected", "no-gate", "forced"]);

const LandReceiptGateSchema = Schema.Struct({
	status: GateStatusSchema,
	command: Schema.optional(Schema.String),
	unprovenGreenRejected: Schema.Boolean,
	newRegressions: Schema.Array(Schema.String),
	baseWasRed: Schema.Boolean,
	detail: Schema.optional(Schema.String),
});

const LandReceiptCostSchema = Schema.Struct({
	costUsd: Schema.optional(Schema.Number),
	costUnknown: Schema.Boolean,
	model: Schema.optional(Schema.String),
	tokens: Schema.optional(Schema.Number),
});

const ReviewerPrecisionStampSchema = Schema.Struct({
	lineage: Schema.String,
	n: Schema.Number,
	survived: Schema.Number,
	survivedRate: Schema.optional(Schema.Number),
	provisional: Schema.Boolean,
	rejected: Schema.optional(Schema.Number),
	corrupt: Schema.optional(Schema.Literal(true)),
	unreadable: Schema.optional(Schema.String),
});

const ModelLineageSchema = Schema.Literals(["anthropic", "openai", "google", "xai", "unknown"]);

const ValidationRecordSchema = Schema.Struct({
	verdict: Schema.Literals(["pass", "veto", "abstain", "skipped", "inconclusive"]),
	agreement: Schema.Number,
	confidence: Schema.Number,
	perCriterion: Schema.Array(Schema.Struct({ id: Schema.String, satisfied: Schema.Boolean, note: Schema.optional(Schema.String) })),
	rationale: Schema.String,
	model: Schema.optional(Schema.String),
	authorLineage: Schema.optional(ModelLineageSchema),
	reviewerLineage: Schema.optional(ModelLineageSchema),
	sameLineage: Schema.optional(Schema.Boolean),
	reviewerPrecision: Schema.optional(ReviewerPrecisionStampSchema),
	ranAt: Schema.Number,
});

const PanelVerdictSchema = Schema.Struct({
	reviewer: Schema.String,
	verdict: Schema.Literals(["approve", "object", "abstain"]),
	precision: Schema.optional(ReviewerPrecisionStampSchema),
	note: Schema.optional(Schema.String),
});

export const LandReceiptSchema = Schema.Struct({
	repo: Schema.String,
	branch: Schema.String,
	commit: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
	files: Schema.Array(Schema.String),
	insertions: Schema.optional(Schema.Number),
	deletions: Schema.optional(Schema.Number),
	landed: Schema.Boolean,
	at: Schema.Number,
	gate: LandReceiptGateSchema,
	validation: Schema.optional(ValidationRecordSchema),
	panel: Schema.optional(Schema.Array(PanelVerdictSchema)),
	rollbackPoint: Schema.optional(Schema.String),
	forcedWithoutProof: Schema.Boolean,
	cost: LandReceiptCostSchema,
});

// Locks this schema to the real `LandReceipt` interface: a future field added to types.ts without a
// matching schema update fails typecheck here, same convention as src/schema/federation-frame.ts.
type _LandReceiptGuard = LandReceipt extends typeof LandReceiptSchema.Type ? true : never;
const _landReceiptGuard: _LandReceiptGuard = true;
