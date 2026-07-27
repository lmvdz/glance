/**
 * Runtime validation for `ManagerChannelPost.event.payload` — the per-kind card contract behind
 * every room timeline card. `TranscriptEventKind` (`../transcript-event-kinds.ts`) closes the
 * `kind` string to a known set; this module closes the `payload` shape behind each of those kinds,
 * keyed the same way, so an agent-influenced card can never smuggle an executable href or an
 * unreviewed wire field past the single chokepoint that persists it (`ChannelStore#appendManager`,
 * `../channels.ts`).
 *
 * Design notes:
 *  - `Schema.Struct` strips fields it doesn't list rather than rejecting them (the same behavior
 *    `client-command.ts` relies on for field-injection). Validation here is OBSERVATIONAL — the
 *    decoded value is never persisted, only its success/failure — so every schema below models
 *    the fields worth constraining (the base face contract, `doorSurface`, `href`, `register`,
 *    and each kind's well-known extras) and lets anything else through unexamined rather than
 *    reaching for `Schema.Record` passthrough where the shape isn't genuinely open. `refs` and
 *    `pinned` ARE genuinely open (their keys vary per kind/emit), so those use `Schema.Record`.
 *  - The projection funnel (`squad-manager.ts#projectUnitTranscriptEvent`) derives one shared
 *    `{ refs, doorSurface, face }` envelope for every kind it routes (`projectionFace` computes a
 *    superset of extras regardless of kind, `needsYouFace`/`tokenBurnFace` are its two exceptions),
 *    so most kinds below share one schema. The four bespoke inline emit sites — design-revised,
 *    mention-steer, return-emit, and the token-burn fleet rollup — get dedicated face schemas
 *    matching their fixed, hand-written shapes, and typed `emitCard` constructors below (the
 *    funnel itself derives faces from `unknown` payloads, where only this runtime check helps —
 *    see 07-card-payload-schemas.md).
 *  - `href` (on `face` and on the payload directly) is constrained to an internal `#/` route.
 *    `sanitizeManagerValue` (`../channels.ts`) neutralizes delimiters and secrets, not URL
 *    schemes, and a face href lands raw in `<a href>` — a `javascript:`/`https:` href in an
 *    agent-influenced string is a click-to-execute sink this schema closes at the source.
 */
import { Result, Schema } from "effect";
import { envBool } from "../config.ts";
import {
	TRANSCRIPT_EVENT_DESIGN_REVISED,
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_GOAL_OVERLAP,
	TRANSCRIPT_EVENT_LAND_ASSESSMENT,
	TRANSCRIPT_EVENT_LAND_ATTEMPT,
	TRANSCRIPT_EVENT_LAND_MERGE,
	TRANSCRIPT_EVENT_MENTION_STEER,
	TRANSCRIPT_EVENT_NEEDS_YOU,
	TRANSCRIPT_EVENT_PLAN_CARD,
	TRANSCRIPT_EVENT_PR_OPENED,
	TRANSCRIPT_EVENT_RETURN_EMIT,
	TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT,
	TRANSCRIPT_EVENT_UNIT_FAILED,
	TRANSCRIPT_EVENT_UNIT_SPAWNED,
	TRANSCRIPT_EVENT_UNIT_TURN_FINISHED,
	TRANSCRIPT_EVENT_VERIFICATION_RAN,
	type TranscriptEventKind,
	isTranscriptEventKind,
} from "../transcript-event-kinds.ts";
import type { TokenBurnFace, TokenBurnRollupPayload } from "../token-burn.ts";
import { formatDecodeIssue } from "./client-command.ts";

/** Mirrored from `webapp/src/lib/channelTimeline.ts#ChannelCardTone` — two independently built
 *  packages (see `tests/channel-card-kinds-sync.test.ts`), no shared import. */
const ToneSchema = Schema.Literals(["neutral", "info", "warning", "success", "destructive"]);

/** Mirrored from `webapp/src/lib/channelTimeline.ts#PointerCardFace["register"]`. Governs face
 *  TEXT (title/body/detail — the claim content), never chrome; absent means default rendering. */
export type CardRegister = "checked" | "claim" | "unverified";
const RegisterSchema = Schema.Literals(["checked", "claim", "unverified"]);

/** Every `doorSurface` a card emitter sets today (`squad-manager.ts#projectionDoorSurface` plus
 *  the three bespoke sites' literals). Closes the surface to what the client actually knows how
 *  to route (`webapp/src/lib/channelTimeline.ts#hrefFromPayload`). */
const DoorSurfaceSchema = Schema.Literals(["plan", "intervence", "land", "land-merge", "gate-verdict", "unit", "fleet-economics"]);

/** Internal-route guard: a card href may only ever be a client hash route. Rejects (schema-side)
 *  `javascript:`/`https:`/any non-`#/` value outright rather than sanitizing it in place — the
 *  whole payload fails validation, which is the signal this module exists to raise. */
const HrefSchema = Schema.String.check(Schema.isPattern(/^#\//));

/** `PointerCardFace["pinned"]` value type — chip values are display primitives, never objects. */
const PinnedValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null, Schema.Undefined]);
const PinnedSchema = Schema.Record(Schema.String, PinnedValueSchema);

/** The `PointerCardFace` contract (`webapp/src/lib/channelTimeline.ts`), codified server-side.
 *  `title` is the one field every real face sets (the funnel falls back to `entry.text`, which is
 *  always a string); everything else is optional chrome or claim content. */
const BaseFaceFields = {
	title: Schema.String,
	eyebrow: Schema.optional(Schema.String),
	body: Schema.optional(Schema.String),
	detail: Schema.optional(Schema.String),
	status: Schema.optional(Schema.String),
	tone: Schema.optional(ToneSchema),
	pinned: Schema.optional(PinnedSchema),
	href: Schema.optional(HrefSchema),
	register: Schema.optional(RegisterSchema),
};
const BaseFaceSchema = Schema.Struct(BaseFaceFields);

/** `refs` is small and enumerable across every emit site (see `projectionRefs`, and the three
 *  bespoke sites) — genuinely closed, not open, so it's modeled field-by-field rather than as a
 *  passthrough record. */
const RefsSchema = Schema.Struct({
	unitId: Schema.optional(Schema.String),
	entryId: Schema.optional(Schema.String),
	planId: Schema.optional(Schema.String),
	planPath: Schema.optional(Schema.String),
	candidateId: Schema.optional(Schema.String),
	landId: Schema.optional(Schema.String),
	issueId: Schema.optional(Schema.String),
	issueIdentifier: Schema.optional(Schema.String),
	reason: Schema.optional(Schema.String),
	// goal-overlap's only ref: the disclosure fires before the new unit has an id, so it names the
	// candidate by its requested display name instead (`squad-manager.ts#spawnAgent`).
	unitName: Schema.optional(Schema.String),
});

/**
 * `squad-manager.ts#projectionFace`'s default branch — shared by every kind it routes generically
 * (land-attempt, land-assessment, land-merge, gate-verdict, plan-card, unit-spawned,
 * unit-turn-finished, unit-failed, pr-opened, verification-ran, and the unit-path half of
 * token-burn-snapshot). One function derives all of these extras regardless of kind, so one face
 * schema covers all of them; `needsYouFace` and `tokenBurnFace` are the two dedicated readers this
 * schema does NOT cover (see below).
 */
const ProjectedFaceSchema = Schema.Struct({
	...BaseFaceFields,
	unitId: Schema.optional(Schema.String),
	unitName: Schema.optional(Schema.String),
	eventKind: Schema.optional(Schema.String),
	repo: Schema.optional(Schema.String),
	branch: Schema.optional(Schema.String),
	issue: Schema.optional(Schema.Unknown),
	stage: Schema.optional(Schema.String),
	sha: Schema.optional(Schema.String),
	target: Schema.optional(Schema.String),
	risk: Schema.optional(Schema.String),
	recommendation: Schema.optional(Schema.String),
	outcome: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.String),
	prUrl: Schema.optional(Schema.String),
	prNumber: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
	doneProofVerified: Schema.optional(Schema.String),
	verdict: Schema.optional(Schema.String),
	ok: Schema.optional(Schema.Boolean),
	merged: Schema.optional(Schema.Boolean),
	pendingId: Schema.optional(Schema.String),
	pendingStatus: Schema.optional(Schema.String),
	validation: Schema.optional(Schema.Unknown),
	agreement: Schema.optional(Schema.Number),
	confidence: Schema.optional(Schema.Number),
	perCriterion: Schema.optional(Schema.Array(Schema.Unknown)),
	planName: Schema.optional(Schema.String),
	concernCount: Schema.optional(Schema.Number),
});

/** `squad-manager.ts#needsYouFace`. */
const NeedsYouFaceSchema = Schema.Struct({
	...BaseFaceFields,
	unitId: Schema.optional(Schema.String),
	unitName: Schema.optional(Schema.String),
	eventKind: Schema.optional(Schema.String),
	pendingId: Schema.optional(Schema.String),
	pendingStatus: Schema.optional(Schema.String),
	age: Schema.optional(Schema.String),
});

/** `squad-manager.ts#appendCommandReturnEmit`'s inline face literal. */
const ReturnEmitFaceSchema = Schema.Struct({
	...BaseFaceFields,
	unitId: Schema.optional(Schema.String),
	unitName: Schema.optional(Schema.String),
	eventKind: Schema.optional(Schema.String),
});

/** `squad-manager.ts#emitDesignRevisedCard`'s inline face literal. */
const DesignRevisedFaceSchema = Schema.Struct({
	...BaseFaceFields,
	unitId: Schema.optional(Schema.String),
	unitName: Schema.optional(Schema.String),
	eventKind: Schema.optional(Schema.String),
	planName: Schema.optional(Schema.String),
});

/** `squad-manager.ts#spawnAgent`'s goal-overlap disclosure (`goalConflict` check) — a bespoke
 *  inline emit added to main after 06/07's original base; registered here in the same reland that
 *  found it (see EXECUTION-LOG.md / this reland's task brief). Deliberately no `body`/`tone`: the
 *  human-readable sentence lives in `text`, not `face.body`, at this emit site. */
const GoalOverlapFaceSchema = Schema.Struct({
	...BaseFaceFields,
	owner: Schema.optional(Schema.String),
	strength: Schema.optional(Schema.String),
});

/** One envelope shape shared by every projected AND bespoke kind: `refs`/`doorSurface` are always
 *  optional at this level because `mention-steer` (bespoke) sets neither. Extra top-level fields a
 *  bespoke site adds (`actor`, `changed`, the fleet-rollup's `totals`/`byUnit`/…) are outside this
 *  struct's field list and are simply not examined — see the file header on passthrough. */
function cardPayload<F extends Schema.Top>(face: F) {
	return Schema.Struct({
		refs: Schema.optional(RefsSchema),
		doorSurface: Schema.optional(DoorSurfaceSchema),
		face,
		href: Schema.optional(HrefSchema),
	});
}

const ProjectedCardPayloadSchema = cardPayload(ProjectedFaceSchema);

/** Keyed by `TranscriptEventKind` (concern 06) — a missing key here is a compile error, so a new
 *  daemon kind must land a schema in the same change (mirrors `tests/channel-card-kinds-sync.test.ts`'s
 *  drift discipline for the webapp registry). */
export const CARD_PAYLOAD_SCHEMAS = {
	[TRANSCRIPT_EVENT_LAND_ATTEMPT]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_LAND_ASSESSMENT]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_LAND_MERGE]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_GATE_VERDICT]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_NEEDS_YOU]: cardPayload(NeedsYouFaceSchema),
	[TRANSCRIPT_EVENT_PLAN_CARD]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_RETURN_EMIT]: cardPayload(ReturnEmitFaceSchema),
	[TRANSCRIPT_EVENT_DESIGN_REVISED]: cardPayload(DesignRevisedFaceSchema),
	// Covers both emit paths for this kind: the per-unit path (funnel, `tokenBurnFace` unit
	// reader — base fields only) and the bespoke fleet-rollup (below) — both produce a face with no
	// extras beyond the base contract.
	[TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT]: cardPayload(BaseFaceSchema),
	[TRANSCRIPT_EVENT_UNIT_SPAWNED]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_UNIT_TURN_FINISHED]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_UNIT_FAILED]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_PR_OPENED]: ProjectedCardPayloadSchema,
	[TRANSCRIPT_EVENT_VERIFICATION_RAN]: ProjectedCardPayloadSchema,
	// Bespoke — no `refs`/`doorSurface` at all (see `appendMentionSteerEcho`); `cardPayload` still
	// applies since both are `optional`.
	[TRANSCRIPT_EVENT_MENTION_STEER]: cardPayload(BaseFaceSchema),
	// Bespoke — `refs: { unitName }` (no unitId; see RefsSchema), `doorSurface: "unit"`.
	[TRANSCRIPT_EVENT_GOAL_OVERLAP]: cardPayload(GoalOverlapFaceSchema),
} satisfies Record<TranscriptEventKind, Schema.Top>;

const DECODERS = Object.fromEntries(
	(Object.entries(CARD_PAYLOAD_SCHEMAS) as Array<[TranscriptEventKind, Schema.Codec<unknown>]>).map(([kind, schema]) => [kind, Schema.decodeUnknownResult(schema)]),
) as Record<TranscriptEventKind, (input: unknown) => Result.Result<unknown, unknown>>;

export interface CardPayloadValidation {
	readonly ok: boolean;
	/** Bounded, single-line reason — set on every failure, used for the test-flag throw. */
	readonly reason?: string;
	/** Set only when THIS call should log: every decode failure for a known kind, but an unknown
	 *  kind only the first time it's seen (a legitimately new kind must not spam per emit). */
	readonly logLine?: string;
}

let cardPayloadFailures = 0;
const warnedUnknownKinds = new Set<string>();

/**
 * Validate a `ManagerChannelPost.event.payload` against its kind's schema. Observational only: the
 * caller (`ChannelStore#appendManager`) always persists the original, unmodified payload
 * regardless of the result — this never re-narrows or normalizes anything, it only reports.
 */
export function validateCardPayload(kind: string, payload: unknown): CardPayloadValidation {
	if (!isTranscriptEventKind(kind)) {
		const firstSeen = !warnedUnknownKinds.has(kind);
		warnedUnknownKinds.add(kind);
		if (!firstSeen) return { ok: false, reason: `no registered card schema for kind "${kind}"` };
		cardPayloadFailures++;
		const reason = `no registered card schema for kind "${kind}" (${cardPayloadFailures} total) — newer daemon or unregistered kind`;
		return { ok: false, reason, logLine: reason };
	}
	const result = DECODERS[kind](payload);
	if (Result.isSuccess(result)) return { ok: true };
	cardPayloadFailures++;
	const reason = `invalid "${kind}" card payload (${cardPayloadFailures} total): ${formatDecodeIssue(result.failure)}`;
	return { ok: false, reason, logLine: reason };
}

/**
 * Strict mode: a decode failure throws instead of just logging, so CI catches a malformed emit
 * the day it's written. Default off — production stays log-only (a dropped card is not obviously
 * better than a malformed one; see 07-card-payload-schemas.md). Tests opt in explicitly, per-test.
 */
export function cardPayloadStrict(): boolean {
	return envBool("OMP_SQUAD_CARD_SCHEMA_STRICT", false);
}

/** @substrate exported for tests only — tests/channel-card-payload-schemas.test.ts resets the
 *  warn-once/counter state between cases so one test's unknown-kind warning doesn't suppress
 *  another's. */
export function __resetCardPayloadValidationState(): void {
	cardPayloadFailures = 0;
	warnedUnknownKinds.clear();
}

type CardPayloadType<K extends TranscriptEventKind> = (typeof CARD_PAYLOAD_SCHEMAS)[K]["Type"];

function emitCardConstructor<K extends TranscriptEventKind>(kind: K) {
	return <P>(payload: P & CardPayloadType<K>): { kind: K; payload: P & CardPayloadType<K> } => ({ kind, payload });
}

/**
 * Typed constructors for the bespoke inline emit sites ONLY (`squad-manager.ts`:
 * `emitDesignRevisedCard` design-revised, `appendMentionSteerEcho` mention-steer,
 * `appendCommandReturnEmit` return-emit, `emitFleetTokenBurnRollup` token-burn-snapshot, `spawnAgent`'s
 * `goalConflict` disclosure goal-overlap). Each asserts the base contract at compile time
 * (`refs`/`doorSurface`/`face` per the kind's schema above) while still allowing the extra
 * top-level fields that site has always sent (`actor`, `changed`, the rollup's `totals`/`byUnit`/…)
 * — the generic `P &` intersection lets those through without excess-property errors, since the
 * runtime schema tolerates them too (see file header).
 *
 * Deliberately NOT used by the projection funnel (`projectUnitTranscriptEvent`): it derives faces
 * from `unknown` transcript payloads, where a compile-time constructor can assert nothing and
 * `validateCardPayload` above is the only check that helps.
 */
export const emitDesignRevisedCard = emitCardConstructor(TRANSCRIPT_EVENT_DESIGN_REVISED);
export const emitMentionSteerCard = emitCardConstructor(TRANSCRIPT_EVENT_MENTION_STEER);
export const emitReturnEmitCard = emitCardConstructor(TRANSCRIPT_EVENT_RETURN_EMIT);
export const emitTokenBurnSnapshotCard = emitCardConstructor(TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT);
export const emitGoalOverlapCard = emitCardConstructor(TRANSCRIPT_EVENT_GOAL_OVERLAP);

/** `emitTokenBurnSnapshotCard`'s payload shape (the fleet-rollup bespoke site only — the unit-path
 *  emit stays in the untyped funnel, see the file header). */
export interface TokenBurnSnapshotCardPayload extends TokenBurnRollupPayload {
	refs: { reason: string };
	doorSurface: "fleet-economics";
	face: TokenBurnFace;
}
// Drift guard: keeps the hand-written interface above honest against the schema it documents.
type _TokenBurnSnapshotPayloadGuard = TokenBurnSnapshotCardPayload extends CardPayloadType<typeof TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT> ? true : never;
const _tokenBurnSnapshotPayloadGuard: _TokenBurnSnapshotPayloadGuard = true;
export const _cardPayloadDriftGuards = [_tokenBurnSnapshotPayloadGuard] as const;
