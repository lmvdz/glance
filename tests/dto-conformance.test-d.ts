/**
 * Type-level DTO conformance (eap-borrows follow-up #3): the webapp's DTOs under
 * `webapp/src/lib/dto.ts` are HAND-MAINTAINED mirrors of backend wire types in `src/types.ts`, with no
 * compiler edge between them — `tsc` passes cleanly on both sides of a field the mirror forgot, dropped,
 * or silently retyped (that's exactly how `ValidationRecordDTO` ended up missing `gateLogPaths`, and had
 * already been missing `lensAdvisory`/`lensVerify`, undetected). This file IS that edge: it is wired
 * into the root tsconfig's `include` (see tsconfig.json) so a violation fails
 * `bunx tsc --noEmit -p .` (part of `bun run check`), not just a runtime read nobody happened to
 * exercise.
 *
 * Blind review follow-up (this file's original SUBSET design didn't catch the bug it was built for): a
 * "DTO keys ⊆ Source keys" check passes trivially the moment someone adds a NEW backend field and simply
 * forgets to mirror it — the DTO stays a valid subset either way, so the exact defect this file exists to
 * catch (`gateLogPaths` sitting on `ValidationRecord` for months with no compiler edge to `dto.ts`) would
 * have sailed straight through the old check too. Redesigned to EQUALITY-minus-an-explicit-omit-list: a
 * DTO's keys must equal its backend source's keys, MINUS a `OmittedFromDto` union the mirror author has
 * to name on purpose. `UnmirroredSourceKeys` is the new arm — every backend field that is neither on the
 * DTO nor in the omit list fails the build. Adding a backend field now forces a conscious choice (mirror
 * it, or name it in `OmittedFromDto`); neither can happen by accident, and both are compile errors
 * otherwise. Verified live: added a throwaway field to `ValidationRecord` with no DTO/omit-list
 * counterpart, confirmed `bunx tsc --noEmit -p .` failed on `_ValidationRecordDtoMirrorsEveryBackendField`
 * naming the new field, then reverted it.
 *
 * `.test-d.ts` naming (mirrors the `tsd`/`expect-type` convention): type-only, no `bun:test` import, no
 * runtime assertions — every import here is `import type`, so the whole file fully erases at
 * transpile time and contributes zero runtime behavior even if a test runner's glob happens to pick it
 * up (bun's default `*.test.{ts,tsx}` glob does not match `*.test-d.ts`, so it isn't run as a test
 * either — this file's only job is to exist inside the `tsc` program).
 */

import type { ValidationRecord , AutomationEvent as SrcAutomationEvent, AutomationLoop as SrcAutomationLoop, AutomationSkipReason as SrcAutomationSkipReason } from "../src/types.ts";
import type { VoiceCallParticipant as SrcVoiceCallParticipant } from "../src/voice-call-manager.ts";
import type { WorkflowGraphEdge as SrcWorkflowGraphEdge, WorkflowGraphNode as SrcWorkflowGraphNode, WorkflowGraphSnapshot as SrcWorkflowGraphSnapshot, WorkflowRunState as SrcWorkflowRunState } from "../src/workflow/types.ts";
import type { ValidationRecordDTO , AutomationEventDTO, AutomationLoopDTO, AutomationSkipReasonDTO, VoiceCallParticipantDTO, WorkflowGraphEdgeDTO, WorkflowGraphNodeDTO, WorkflowGraphSnapshotDTO, WorkflowRunStateDTO } from "../webapp/src/lib/dto.ts";

/** Mutual-assignability type equality — `true` only when `A` and `B` are the EXACT same type (not
 *  merely assignable one way), so a widened/narrowed DTO field is caught, not just a missing one. The
 *  double-conditional-over-generic-function form is the standard `tsd`/`expect-type` idiom; it avoids
 *  the naive `A extends B ? B extends A ? ... : false : false` form's false positives on `any` and its
 *  failures across distributive-conditional-type edge cases. */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless `T` is exactly `true` — assigning a computed `false` (or anything else) to
 *  this generic's constraint is a type error at the assertion site, not a boolean you'd have to run
 *  something to notice. */
export type Expect<T extends true> = T;

/** Keys `Dto` declares that `Source` does not have at all — must be `never`. A non-`never` result here
 *  IS the offending key name(s), surfaced directly in the compiler error (e.g. a field renamed on the
 *  backend, leaving a now-orphaned DTO key of the old name). */
export type ExtraDtoKeys<Dto, Source> = Exclude<keyof Dto, keyof Source>;

/** Keys BOTH types share whose value types diverge — must be `never`. A non-`never` result here is the
 *  key(s) whose type drifted between the backend source and its DTO mirror. */
export type MismatchedSharedKeys<Dto, Source, Allowed extends keyof Source = never> = Exclude<
	{
		// Pick-based, not Dto[K] vs Source[K] (codex M, concern 24 round): indexing erases the
		// optionality MODIFIER — `foo?: string` and `foo: string | undefined` both index to
		// `string | undefined`, so a field flipping presence-required passed silently. Comparing
		// the one-key Pick keeps the modifier in the compared type.
		[K in keyof Dto & keyof Source]: Equals<Pick<Dto, K>, Pick<Source, K & keyof Dto>> extends true ? never : K;
	}[keyof Dto & keyof Source],
	Allowed
>;

/** Keys `Source` declares that NEITHER `Dto` NOR the explicit `Omitted` union covers — must be `never`.
 *  A non-`never` result here IS the offending key name(s): a backend field nobody made a conscious
 *  decision about yet. This is the arm the old subset-only check was missing — `ExtraDtoKeys` alone
 *  can never fail on a field that simply never got added to the DTO, which is exactly how
 *  `gateLogPaths` went unmirrored for months with a "passing" conformance file sitting right next to
 *  it. Combined with `ExtraDtoKeys` + `MismatchedSharedKeys`, the three checks together assert
 *  `keyof Dto === keyof Source \ Omitted` — equality minus a deliberate, named exclusion list, not a
 *  one-directional subset. */
export type UnmirroredSourceKeys<Dto, Source, Omitted extends keyof Source = never> = Exclude<keyof Source, keyof Dto | Omitted>;

// ── ValidationRecordDTO == ValidationRecord \ OmittedFromValidationRecordDto ────────────────────────────
// The concrete drift this follow-up closes: `gateLogPaths` (and, pre-existing, `lensAdvisory`/
// `lensVerify`) were on `ValidationRecord` but missing from `ValidationRecordDTO` — added to the DTO
// alongside this check so the NEXT such field can't repeat it silently. Every field on `ValidationRecord`
// is mirrored today, so this omit list is empty — the NEXT backend field added here must either be
// mirrored onto `ValidationRecordDTO` or named below on purpose; leaving it out of both fails the build
// via `_ValidationRecordDtoMirrorsEveryBackendField`, not silently.
export type OmittedFromValidationRecordDto = never;
export type _ValidationRecordDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<ValidationRecordDTO, ValidationRecord>] extends [never] ? true : false>;
export type _ValidationRecordDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<ValidationRecordDTO, ValidationRecord>] extends [never] ? true : false>;
export type _ValidationRecordDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<ValidationRecordDTO, ValidationRecord, OmittedFromValidationRecordDto>] extends [never] ? true : false>;

import type { AgentDTO as SrcAgentDTO, AgentKind as SrcAgentKind, AgentReport as SrcAgentReport, AgentSessionSummary as SrcAgentSessionSummary, AgentStatus as SrcAgentStatus, ArtifactCommentDTO as SrcArtifactCommentDTO, AttentionEvent as SrcAttentionEvent, AuditEntry as SrcAuditEntry, ClientCommand as SrcClientCommand, CommandInfo as SrcCommandInfo, ExecutionRole as SrcExecutionRole, FeatureCategory as SrcFeatureCategory, FeatureCriterion as SrcFeatureCriterion, FeatureDTO as SrcFeatureDTO, FeatureProofAggregate as SrcFeatureProofAggregate, FeatureReadiness as SrcFeatureReadiness, FeatureReadinessState as SrcFeatureReadinessState, FeatureRelationship as SrcFeatureRelationship, FeatureStage as SrcFeatureStage, FeatureWorktreeStatus as SrcFeatureWorktreeStatus, IssueRef as SrcIssueRef, LandReadiness as SrcLandReadiness, LensVerdict as SrcLensVerdict, PendingRequest as SrcPendingRequest, PlanAnnotationTarget as SrcPlanAnnotationTarget, PlanRevisionCandidate as SrcPlanRevisionCandidate, PlanRevisionCandidateState as SrcPlanRevisionCandidateState, PresenceSnapshot as SrcPresenceSnapshot, PresenceUser as SrcPresenceUser, ProjectDTO as SrcProjectDTO, SquadEvent as SrcSquadEvent, TranscriptEntry as SrcTranscriptEntry, TranscriptEvent as SrcTranscriptEvent, TranscriptFormat as SrcTranscriptFormat, TranscriptPending as SrcTranscriptPending, TranscriptTool as SrcTranscriptTool, TransitionEntry as SrcTransitionEntry, TypingEvent as SrcTypingEvent, WorktreeProofSummary as SrcWorktreeProofSummary } from "../src/types.ts";
import type { AgentDTO, AgentKind, AgentReport, AgentSessionSummaryDTO, AgentStatus, ArtifactCommentDTO, AttentionEvent, AuditEntry, ClientCommand, CommandInfo, ExecutionRole, FeatureCategoryDTO, FeatureCriterionDTO, FeatureDTO, FeatureProofAggregateDTO, FeatureReadinessDTO, FeatureReadinessStateDTO, FeatureRelationshipDTO, FeatureStage, FeatureWorktreeStatusDTO, IssueRef, LandReadinessDTO, LensVerdictDTO, PendingRequest, PlanAnnotationTargetDTO, PlanRevisionCandidateDTO, PlanRevisionCandidateStateDTO, PresenceSnapshot, PresenceUser, ProjectDTO, SquadEvent, TranscriptEntry, TranscriptEvent, TranscriptFormat, TranscriptPending, TranscriptTool, TransitionEntry, TypingEvent, WorktreeProofSummaryDTO } from "../webapp/src/lib/dto.ts";

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Concern 24 (deepen-modules round 2): the machinery above, applied to every mirrored pair — 25
// exact-name pairs + 15 XDTO↔X pairs. Same contract everywhere: DTO keys == source keys minus an
// explicitly NAMED omit list; shared keys type-identical. Discriminated unions (SquadEvent,
// ClientCommand) get variant-keyed checks so a compiler error names the drifted VARIANT, not just
// "the union differs". Every non-`never` Omitted* member below is a deliberate, documented decision.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

/** The discriminants the DTO union is missing vs its source — must be `never`. */
export type MissingVariants<DtoU extends { type: string }, SrcU extends { type: string }> = Exclude<SrcU["type"], DtoU["type"]>;
/** Discriminants the DTO union invents that the source never emits — must be `never`. */
export type ExtraVariants<DtoU extends { type: string }, SrcU extends { type: string }> = Exclude<DtoU["type"], SrcU["type"]>;
/** Per-variant KEY drift, keyed by discriminant so the error NAMES the drifted variant. Value-type
 *  equality is deliberately not required at this level — variant payloads embed further mirrored
 *  types with their own pair checks; key-set equality keeps one drifted leaf from cascading into a
 *  wall of variant errors. */
export type DriftedVariants<DtoU extends { type: string }, SrcU extends { type: string }, AllowedFields extends string = never> = {
	// Key sets AND shared-field types (codex H, concern 24 round): key-set-only comparison let a
	// variant field's type or optionality drift silently. Field-level allowances are named as
	// "variant.field" strings — the shallow create.options/commission.spec payloads are visible
	// decisions now, not comment-only ones.
	[K in DtoU["type"] & SrcU["type"]]: Equals<keyof Extract<DtoU, { type: K }>, keyof Extract<SrcU, { type: K }>> extends true
		? {
				[F in keyof Extract<DtoU, { type: K }> & keyof Extract<SrcU, { type: K }> & string]: `${K & string}.${F}` extends AllowedFields
					? never
					: Equals<Pick<Extract<DtoU, { type: K }>, F>, Pick<Extract<SrcU, { type: K }>, F & keyof Extract<DtoU, { type: K }>>> extends true
						? never
						: K;
			}[keyof Extract<DtoU, { type: K }> & keyof Extract<SrcU, { type: K }> & string]
		: K;
}[DtoU["type"] & SrcU["type"]];

// ── AgentDTO == AgentDTO \ omits, with NAMED deliberate divergences (slice 2) ──────────────────
/** The four fields whose value types deliberately diverge, each a documented decision:
 *  - transitions: the dto widens TransitionEntry.reason to string (AllowedTransitionEntryMismatches).
 *  - workflowGraph: the dto widens node.kind (engine NodeKind) to string — the timeline renders
 *    labels, never branches on engine node kinds.
 *  - workflowState: the dto DECLARATION is a deliberate render subset of WorkflowRunState — the
 *    JSON on the wire carries the full engine object (builders assign it verbatim); the subset is
 *    what the client PROMISES to read, gated leaf-level below (OmittedFromWorkflowRunStateDto).
 *  - todoPhases: the dto names its own TodoPhaseDTO/TodoStatus instead of reaching into
 *    RpcSessionState's harness-shaped type. */
/** NOTE on allowance grain (codex M2): a field named here is suppressed WHOLESALE at the
 *  AgentDTO level — wrapper drift included. That is why each allowed field carries its own
 *  LEAF pair gate below (WorkflowRunStateDTO / WorkflowGraphSnapshotDTO / WorkflowGraphNodeDTO;
 *  transitions' element is gated by the TransitionEntry pair) — the residual blind spot is
 *  wrapper-shape drift on transitions alone, named here rather than silently absorbed. */
export type AllowedAgentDtoMismatches = "transitions" | "workflowGraph" | "workflowState";
export type OmittedFromAgentDto = never;
export type _AgentDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<AgentDTO, SrcAgentDTO>] extends [never] ? true : false>;
export type _AgentDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<AgentDTO, SrcAgentDTO, AllowedAgentDtoMismatches>] extends [never] ? true : false>;
export type _AgentDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<AgentDTO, SrcAgentDTO, OmittedFromAgentDto>] extends [never] ? true : false>;

// ── AgentReport == AgentReport \ OmittedFromAgentReportDto ─────────────────────────────
export type OmittedFromAgentReportDto = never;
export type _AgentReportDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<AgentReport, SrcAgentReport>] extends [never] ? true : false>;
export type _AgentReportDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<AgentReport, SrcAgentReport>] extends [never] ? true : false>;
export type _AgentReportDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<AgentReport, SrcAgentReport, OmittedFromAgentReportDto>] extends [never] ? true : false>;

// ── ArtifactCommentDTO == ArtifactCommentDTO \ OmittedFromArtifactCommentDto ─────────────────────────────
export type OmittedFromArtifactCommentDto = never;
export type _ArtifactCommentDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<ArtifactCommentDTO, SrcArtifactCommentDTO>] extends [never] ? true : false>;
export type _ArtifactCommentDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<ArtifactCommentDTO, SrcArtifactCommentDTO>] extends [never] ? true : false>;
export type _ArtifactCommentDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<ArtifactCommentDTO, SrcArtifactCommentDTO, OmittedFromArtifactCommentDto>] extends [never] ? true : false>;

// ── AttentionEvent == AttentionEvent \ OmittedFromAttentionEventDto ─────────────────────────────
export type OmittedFromAttentionEventDto = never;
export type _AttentionEventDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<AttentionEvent, SrcAttentionEvent>] extends [never] ? true : false>;
export type _AttentionEventDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<AttentionEvent, SrcAttentionEvent>] extends [never] ? true : false>;
export type _AttentionEventDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<AttentionEvent, SrcAttentionEvent, OmittedFromAttentionEventDto>] extends [never] ? true : false>;

// ── AuditEntry == AuditEntry \ OmittedFromAuditEntryDto ─────────────────────────────
export type OmittedFromAuditEntryDto = never;
export type _AuditEntryDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<AuditEntry, SrcAuditEntry>] extends [never] ? true : false>;
export type _AuditEntryDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<AuditEntry, SrcAuditEntry>] extends [never] ? true : false>;
export type _AuditEntryDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<AuditEntry, SrcAuditEntry, OmittedFromAuditEntryDto>] extends [never] ? true : false>;

// ── CommandInfo == CommandInfo \ OmittedFromCommandInfoDto ─────────────────────────────
export type OmittedFromCommandInfoDto = never;
export type _CommandInfoDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<CommandInfo, SrcCommandInfo>] extends [never] ? true : false>;
export type _CommandInfoDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<CommandInfo, SrcCommandInfo>] extends [never] ? true : false>;
export type _CommandInfoDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<CommandInfo, SrcCommandInfo, OmittedFromCommandInfoDto>] extends [never] ? true : false>;

// ── FeatureDTO == FeatureDTO \ OmittedFromFeatureDto ─────────────────────────────
export type OmittedFromFeatureDto = never;
export type _FeatureDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureDTO, SrcFeatureDTO>] extends [never] ? true : false>;
export type _FeatureDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureDTO, SrcFeatureDTO>] extends [never] ? true : false>;
export type _FeatureDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureDTO, SrcFeatureDTO, OmittedFromFeatureDto>] extends [never] ? true : false>;

// ── IssueRef == IssueRef \ OmittedFromIssueRefDto ─────────────────────────────
export type OmittedFromIssueRefDto = never;
export type _IssueRefDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<IssueRef, SrcIssueRef>] extends [never] ? true : false>;
export type _IssueRefDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<IssueRef, SrcIssueRef>] extends [never] ? true : false>;
export type _IssueRefDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<IssueRef, SrcIssueRef, OmittedFromIssueRefDto>] extends [never] ? true : false>;

// ── PendingRequest == PendingRequest \ OmittedFromPendingRequestDto ─────────────────────────────
export type OmittedFromPendingRequestDto = never;
export type _PendingRequestDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<PendingRequest, SrcPendingRequest>] extends [never] ? true : false>;
export type _PendingRequestDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<PendingRequest, SrcPendingRequest>] extends [never] ? true : false>;
export type _PendingRequestDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<PendingRequest, SrcPendingRequest, OmittedFromPendingRequestDto>] extends [never] ? true : false>;

// ── PresenceSnapshot == PresenceSnapshot \ OmittedFromPresenceSnapshotDto ─────────────────────────────
export type OmittedFromPresenceSnapshotDto = never;
export type _PresenceSnapshotDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<PresenceSnapshot, SrcPresenceSnapshot>] extends [never] ? true : false>;
export type _PresenceSnapshotDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<PresenceSnapshot, SrcPresenceSnapshot>] extends [never] ? true : false>;
export type _PresenceSnapshotDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<PresenceSnapshot, SrcPresenceSnapshot, OmittedFromPresenceSnapshotDto>] extends [never] ? true : false>;

// ── PresenceUser == PresenceUser \ OmittedFromPresenceUserDto ─────────────────────────────
export type OmittedFromPresenceUserDto = never;
export type _PresenceUserDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<PresenceUser, SrcPresenceUser>] extends [never] ? true : false>;
export type _PresenceUserDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<PresenceUser, SrcPresenceUser>] extends [never] ? true : false>;
export type _PresenceUserDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<PresenceUser, SrcPresenceUser, OmittedFromPresenceUserDto>] extends [never] ? true : false>;

// ── ProjectDTO == ProjectDTO \ OmittedFromProjectDto ─────────────────────────────
export type OmittedFromProjectDto = never;
export type _ProjectDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<ProjectDTO, SrcProjectDTO>] extends [never] ? true : false>;
export type _ProjectDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<ProjectDTO, SrcProjectDTO>] extends [never] ? true : false>;
export type _ProjectDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<ProjectDTO, SrcProjectDTO, OmittedFromProjectDto>] extends [never] ? true : false>;

// ── TranscriptEntry == TranscriptEntry \ OmittedFromTranscriptEntryDto ─────────────────────────────
export type OmittedFromTranscriptEntryDto = never;
export type _TranscriptEntryDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<TranscriptEntry, SrcTranscriptEntry>] extends [never] ? true : false>;
export type _TranscriptEntryDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<TranscriptEntry, SrcTranscriptEntry>] extends [never] ? true : false>;
export type _TranscriptEntryDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<TranscriptEntry, SrcTranscriptEntry, OmittedFromTranscriptEntryDto>] extends [never] ? true : false>;

// ── TranscriptEvent == TranscriptEvent \ OmittedFromTranscriptEventDto ─────────────────────────────
export type OmittedFromTranscriptEventDto = never;
export type _TranscriptEventDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<TranscriptEvent, SrcTranscriptEvent>] extends [never] ? true : false>;
export type _TranscriptEventDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<TranscriptEvent, SrcTranscriptEvent>] extends [never] ? true : false>;
export type _TranscriptEventDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<TranscriptEvent, SrcTranscriptEvent, OmittedFromTranscriptEventDto>] extends [never] ? true : false>;

// ── TranscriptPending == TranscriptPending \ OmittedFromTranscriptPendingDto ─────────────────────────────
export type OmittedFromTranscriptPendingDto = never;
export type _TranscriptPendingDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<TranscriptPending, SrcTranscriptPending>] extends [never] ? true : false>;
export type _TranscriptPendingDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<TranscriptPending, SrcTranscriptPending>] extends [never] ? true : false>;
export type _TranscriptPendingDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<TranscriptPending, SrcTranscriptPending, OmittedFromTranscriptPendingDto>] extends [never] ? true : false>;

// ── TranscriptTool == TranscriptTool \ OmittedFromTranscriptToolDto ─────────────────────────────
export type OmittedFromTranscriptToolDto = never;
export type _TranscriptToolDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<TranscriptTool, SrcTranscriptTool>] extends [never] ? true : false>;
export type _TranscriptToolDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<TranscriptTool, SrcTranscriptTool>] extends [never] ? true : false>;
export type _TranscriptToolDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<TranscriptTool, SrcTranscriptTool, OmittedFromTranscriptToolDto>] extends [never] ? true : false>;

// ── TransitionEntry == TransitionEntry \ OmittedFromTransitionEntryDto ─────────────────────────────
export type OmittedFromTransitionEntryDto = never;
/** DELIBERATE divergence (the dto declares it inline): the webapp widens reason to string — it only
 *  displays reasons, never branches exhaustively, and the backend union churns with every lifecycle
 *  concern. The ALLOWANCE is named here so any OTHER TransitionEntry field drifting still fails. */
export type AllowedTransitionEntryMismatches = "reason";
export type _TransitionEntryDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<TransitionEntry, SrcTransitionEntry>] extends [never] ? true : false>;
export type _TransitionEntryDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<TransitionEntry, SrcTransitionEntry, AllowedTransitionEntryMismatches>] extends [never] ? true : false>;
export type _TransitionEntryDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<TransitionEntry, SrcTransitionEntry, OmittedFromTransitionEntryDto>] extends [never] ? true : false>;

// ── TypingEvent == TypingEvent \ OmittedFromTypingEventDto ─────────────────────────────
export type OmittedFromTypingEventDto = never;
export type _TypingEventDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<TypingEvent, SrcTypingEvent>] extends [never] ? true : false>;
export type _TypingEventDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<TypingEvent, SrcTypingEvent>] extends [never] ? true : false>;
export type _TypingEventDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<TypingEvent, SrcTypingEvent, OmittedFromTypingEventDto>] extends [never] ? true : false>;

// ── AgentSessionSummaryDTO == AgentSessionSummary \ OmittedFromAgentSessionSummaryDto ─────────────────────────────
export type OmittedFromAgentSessionSummaryDto = never;
export type _AgentSessionSummaryDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<AgentSessionSummaryDTO, SrcAgentSessionSummary>] extends [never] ? true : false>;
export type _AgentSessionSummaryDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<AgentSessionSummaryDTO, SrcAgentSessionSummary>] extends [never] ? true : false>;
export type _AgentSessionSummaryDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<AgentSessionSummaryDTO, SrcAgentSessionSummary, OmittedFromAgentSessionSummaryDto>] extends [never] ? true : false>;

// ── FeatureCategoryDTO == FeatureCategory \ OmittedFromFeatureCategoryDto ─────────────────────────────
export type OmittedFromFeatureCategoryDto = never;
export type _FeatureCategoryDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureCategoryDTO, SrcFeatureCategory>] extends [never] ? true : false>;
export type _FeatureCategoryDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureCategoryDTO, SrcFeatureCategory>] extends [never] ? true : false>;
export type _FeatureCategoryDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureCategoryDTO, SrcFeatureCategory, OmittedFromFeatureCategoryDto>] extends [never] ? true : false>;

// ── FeatureCriterionDTO == FeatureCriterion \ OmittedFromFeatureCriterionDto ─────────────────────────────
export type OmittedFromFeatureCriterionDto = never;
export type _FeatureCriterionDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureCriterionDTO, SrcFeatureCriterion>] extends [never] ? true : false>;
export type _FeatureCriterionDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureCriterionDTO, SrcFeatureCriterion>] extends [never] ? true : false>;
export type _FeatureCriterionDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureCriterionDTO, SrcFeatureCriterion, OmittedFromFeatureCriterionDto>] extends [never] ? true : false>;

// ── FeatureProofAggregateDTO == FeatureProofAggregate \ OmittedFromFeatureProofAggregateDto ─────────────────────────────
export type OmittedFromFeatureProofAggregateDto = never;
export type _FeatureProofAggregateDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureProofAggregateDTO, SrcFeatureProofAggregate>] extends [never] ? true : false>;
export type _FeatureProofAggregateDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureProofAggregateDTO, SrcFeatureProofAggregate>] extends [never] ? true : false>;
export type _FeatureProofAggregateDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureProofAggregateDTO, SrcFeatureProofAggregate, OmittedFromFeatureProofAggregateDto>] extends [never] ? true : false>;

// ── FeatureReadinessDTO == FeatureReadiness \ OmittedFromFeatureReadinessDto ─────────────────────────────
export type OmittedFromFeatureReadinessDto = never;
export type _FeatureReadinessDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureReadinessDTO, SrcFeatureReadiness>] extends [never] ? true : false>;
export type _FeatureReadinessDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureReadinessDTO, SrcFeatureReadiness>] extends [never] ? true : false>;
export type _FeatureReadinessDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureReadinessDTO, SrcFeatureReadiness, OmittedFromFeatureReadinessDto>] extends [never] ? true : false>;

// ── FeatureRelationshipDTO == FeatureRelationship \ OmittedFromFeatureRelationshipDto ─────────────────────────────
export type OmittedFromFeatureRelationshipDto = never;
export type _FeatureRelationshipDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureRelationshipDTO, SrcFeatureRelationship>] extends [never] ? true : false>;
export type _FeatureRelationshipDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureRelationshipDTO, SrcFeatureRelationship>] extends [never] ? true : false>;
export type _FeatureRelationshipDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureRelationshipDTO, SrcFeatureRelationship, OmittedFromFeatureRelationshipDto>] extends [never] ? true : false>;

// ── FeatureWorktreeStatusDTO == FeatureWorktreeStatus \ OmittedFromFeatureWorktreeStatusDto ─────────────────────────────
export type OmittedFromFeatureWorktreeStatusDto = never;
export type _FeatureWorktreeStatusDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<FeatureWorktreeStatusDTO, SrcFeatureWorktreeStatus>] extends [never] ? true : false>;
export type _FeatureWorktreeStatusDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<FeatureWorktreeStatusDTO, SrcFeatureWorktreeStatus>] extends [never] ? true : false>;
export type _FeatureWorktreeStatusDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<FeatureWorktreeStatusDTO, SrcFeatureWorktreeStatus, OmittedFromFeatureWorktreeStatusDto>] extends [never] ? true : false>;

// ── LandReadinessDTO == LandReadiness \ OmittedFromLandReadinessDto ─────────────────────────────
export type OmittedFromLandReadinessDto = never;
export type _LandReadinessDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<LandReadinessDTO, SrcLandReadiness>] extends [never] ? true : false>;
export type _LandReadinessDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<LandReadinessDTO, SrcLandReadiness>] extends [never] ? true : false>;
export type _LandReadinessDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<LandReadinessDTO, SrcLandReadiness, OmittedFromLandReadinessDto>] extends [never] ? true : false>;

// ── LensVerdictDTO == LensVerdict \ OmittedFromLensVerdictDto ─────────────────────────────
export type OmittedFromLensVerdictDto = never;
export type _LensVerdictDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<LensVerdictDTO, SrcLensVerdict>] extends [never] ? true : false>;
export type _LensVerdictDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<LensVerdictDTO, SrcLensVerdict>] extends [never] ? true : false>;
export type _LensVerdictDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<LensVerdictDTO, SrcLensVerdict, OmittedFromLensVerdictDto>] extends [never] ? true : false>;

// ── PlanAnnotationTargetDTO == PlanAnnotationTarget \ OmittedFromPlanAnnotationTargetDto ─────────────────────────────
export type OmittedFromPlanAnnotationTargetDto = never;
export type _PlanAnnotationTargetDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<PlanAnnotationTargetDTO, SrcPlanAnnotationTarget>] extends [never] ? true : false>;
export type _PlanAnnotationTargetDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<PlanAnnotationTargetDTO, SrcPlanAnnotationTarget>] extends [never] ? true : false>;
export type _PlanAnnotationTargetDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<PlanAnnotationTargetDTO, SrcPlanAnnotationTarget, OmittedFromPlanAnnotationTargetDto>] extends [never] ? true : false>;

// ── PlanRevisionCandidateDTO == PlanRevisionCandidate \ OmittedFromPlanRevisionCandidateDto ─────────────────────────────
export type OmittedFromPlanRevisionCandidateDto = never;
export type _PlanRevisionCandidateDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<PlanRevisionCandidateDTO, SrcPlanRevisionCandidate>] extends [never] ? true : false>;
export type _PlanRevisionCandidateDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<PlanRevisionCandidateDTO, SrcPlanRevisionCandidate>] extends [never] ? true : false>;
export type _PlanRevisionCandidateDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<PlanRevisionCandidateDTO, SrcPlanRevisionCandidate, OmittedFromPlanRevisionCandidateDto>] extends [never] ? true : false>;

// ── WorktreeProofSummaryDTO == WorktreeProofSummary \ OmittedFromWorktreeProofSummaryDto ─────────────────────────────
export type OmittedFromWorktreeProofSummaryDto = never;
export type _WorktreeProofSummaryDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<WorktreeProofSummaryDTO, SrcWorktreeProofSummary>] extends [never] ? true : false>;
export type _WorktreeProofSummaryDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<WorktreeProofSummaryDTO, SrcWorktreeProofSummary>] extends [never] ? true : false>;
export type _WorktreeProofSummaryDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<WorktreeProofSummaryDTO, SrcWorktreeProofSummary, OmittedFromWorktreeProofSummaryDto>] extends [never] ? true : false>;

// ── AgentKind === AgentKind (alias equality — a widened or narrowed union member is drift) ────────────────
export type _AgentKindDtoIdentical = Expect<Equals<AgentKind, SrcAgentKind>>;

// ── AgentStatus === AgentStatus (alias equality — a widened or narrowed union member is drift) ────────────────
export type _AgentStatusDtoIdentical = Expect<Equals<AgentStatus, SrcAgentStatus>>;

// ── ExecutionRole === ExecutionRole (alias equality — a widened or narrowed union member is drift) ────────────────
export type _ExecutionRoleDtoIdentical = Expect<Equals<ExecutionRole, SrcExecutionRole>>;

// ── FeatureStage === FeatureStage (alias equality — a widened or narrowed union member is drift) ────────────────
export type _FeatureStageDtoIdentical = Expect<Equals<FeatureStage, SrcFeatureStage>>;

// ── TranscriptFormat === TranscriptFormat (alias equality — a widened or narrowed union member is drift) ────────────────
export type _TranscriptFormatDtoIdentical = Expect<Equals<TranscriptFormat, SrcTranscriptFormat>>;

// ── FeatureReadinessStateDTO === FeatureReadinessState (alias equality — a widened or narrowed union member is drift) ────────────────
export type _FeatureReadinessStateDtoIdentical = Expect<Equals<FeatureReadinessStateDTO, SrcFeatureReadinessState>>;

// ── PlanRevisionCandidateStateDTO === PlanRevisionCandidateState (alias equality — a widened or narrowed union member is drift) ────────────────
export type _PlanRevisionCandidateStateDtoIdentical = Expect<Equals<PlanRevisionCandidateStateDTO, SrcPlanRevisionCandidateState>>;

// ── SquadEvent union == SquadEvent union, variant-keyed ─────────────────────────────────────────────────────
/** Named field-level allowances: agent.agent + roster.agents carry AgentDTO, whose divergence is
 *  concern 24 SLICE 2 (see the deferred block above) — allowing the FIELD here keeps every other
 *  field of those variants gated while the pair itself is open. transition.entry carries
 *  TransitionEntry, whose sole divergence is the named reason widening
 *  (AllowedTransitionEntryMismatches) — allowed here so it doesn't double-report. */
export type AllowedSquadEventFieldDrift = "agent.agent" | "roster.agents" | "transition.entry";
export type _SquadEventDtoNoMissingVariants = Expect<[MissingVariants<SquadEvent, SrcSquadEvent>] extends [never] ? true : false>;
export type _SquadEventDtoNoExtraVariants = Expect<[ExtraVariants<SquadEvent, SrcSquadEvent>] extends [never] ? true : false>;
export type _SquadEventDtoNoDriftedVariants = Expect<[DriftedVariants<SquadEvent, SrcSquadEvent, AllowedSquadEventFieldDrift>] extends [never] ? true : false>;

// ── ClientCommand union == ClientCommand union, variant-keyed ─────────────────────────────────────────────────────
/** Named field-level allowances: the webapp deliberately mirrors create.options and
 *  commission.spec SHALLOWLY (Record<string, unknown>) — the daemon decodes them with its own
 *  schemas, and the webapp gains typed builders when it grows those affordances. The allowance
 *  makes that a compiler-visible decision (codex H, concern 24 round), not a comment-only one. */
export type AllowedClientCommandFieldDrift = "create.options" | "commission.spec";
export type _ClientCommandDtoNoMissingVariants = Expect<[MissingVariants<ClientCommand, SrcClientCommand>] extends [never] ? true : false>;
export type _ClientCommandDtoNoExtraVariants = Expect<[ExtraVariants<ClientCommand, SrcClientCommand>] extends [never] ? true : false>;
export type _ClientCommandDtoNoDriftedVariants = Expect<[DriftedVariants<ClientCommand, SrcClientCommand, AllowedClientCommandFieldDrift>] extends [never] ? true : false>;

// ── The mirrors concern 24 itself introduced — gated from birth (codex M, concern 24 round) ─────
export type OmittedFromAutomationEventDto = never;
export type _AutomationEventDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<AutomationEventDTO, SrcAutomationEvent>] extends [never] ? true : false>;
export type _AutomationEventDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<AutomationEventDTO, SrcAutomationEvent>] extends [never] ? true : false>;
export type _AutomationEventDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<AutomationEventDTO, SrcAutomationEvent, OmittedFromAutomationEventDto>] extends [never] ? true : false>;
export type _AutomationLoopDtoIdentical = Expect<Equals<AutomationLoopDTO, SrcAutomationLoop>>;
export type _AutomationSkipReasonDtoIdentical = Expect<Equals<AutomationSkipReasonDTO, SrcAutomationSkipReason>>;
export type OmittedFromVoiceCallParticipantDto = never;
export type _VoiceCallParticipantDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<VoiceCallParticipantDTO, SrcVoiceCallParticipant>] extends [never] ? true : false>;
export type _VoiceCallParticipantDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<VoiceCallParticipantDTO, SrcVoiceCallParticipant>] extends [never] ? true : false>;
export type _VoiceCallParticipantDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<VoiceCallParticipantDTO, SrcVoiceCallParticipant, OmittedFromVoiceCallParticipantDto>] extends [never] ? true : false>;

// ── Leaf gates under the AgentDTO allowances (codex M2, concern 24 round) ───────────────────────
/** The engine-only fields the render-subset DTO deliberately does not promise to read — each
 *  present in the wire JSON, none consumed by the client. A NEW engine field must be named here
 *  or mirrored; it can no longer hide behind the AgentDTO-level workflowState allowance. */
export type OmittedFromWorkflowRunStateDto = "index" | "goal" | "cold" | "proof" | "sessionId" | "forkedFrom" | "autonomy" | "resumeAttempts" | "transient" | "branchOutcomes";
export type _WorkflowRunStateDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<WorkflowRunStateDTO, SrcWorkflowRunState>] extends [never] ? true : false>;
export type _WorkflowRunStateDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<WorkflowRunStateDTO, SrcWorkflowRunState>] extends [never] ? true : false>;
export type _WorkflowRunStateDtoMirrorsRest = Expect<[UnmirroredSourceKeys<WorkflowRunStateDTO, SrcWorkflowRunState, OmittedFromWorkflowRunStateDto>] extends [never] ? true : false>;

/** nodes diverges only through the node's kind widening — gated at the node pair below. */
export type AllowedWorkflowGraphSnapshotMismatches = "nodes";
export type _WorkflowGraphSnapshotDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<WorkflowGraphSnapshotDTO, SrcWorkflowGraphSnapshot>] extends [never] ? true : false>;
export type _WorkflowGraphSnapshotDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<WorkflowGraphSnapshotDTO, SrcWorkflowGraphSnapshot, AllowedWorkflowGraphSnapshotMismatches>] extends [never] ? true : false>;
export type _WorkflowGraphSnapshotDtoMirrorsRest = Expect<[UnmirroredSourceKeys<WorkflowGraphSnapshotDTO, SrcWorkflowGraphSnapshot>] extends [never] ? true : false>;

/** The one deliberate node divergence: engine NodeKind widens to string on the wire mirror —
 *  the timeline renders labels, never branches on engine node kinds. */
export type AllowedWorkflowGraphNodeMismatches = "kind";
export type _WorkflowGraphNodeDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<WorkflowGraphNodeDTO, SrcWorkflowGraphNode>] extends [never] ? true : false>;
export type _WorkflowGraphNodeDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<WorkflowGraphNodeDTO, SrcWorkflowGraphNode, AllowedWorkflowGraphNodeMismatches>] extends [never] ? true : false>;
export type _WorkflowGraphNodeDtoMirrorsRest = Expect<[UnmirroredSourceKeys<WorkflowGraphNodeDTO, SrcWorkflowGraphNode>] extends [never] ? true : false>;

export type _WorkflowGraphEdgeDtoIdentical = Expect<[ExtraDtoKeys<WorkflowGraphEdgeDTO, SrcWorkflowGraphEdge> | MismatchedSharedKeys<WorkflowGraphEdgeDTO, SrcWorkflowGraphEdge> | UnmirroredSourceKeys<WorkflowGraphEdgeDTO, SrcWorkflowGraphEdge>] extends [never] ? true : false>;
