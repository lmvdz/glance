/**
 * Runtime validation for the untrusted JSON bodies of `SquadServer`'s HTTP API
 * (`src/server.ts`). ~33 handlers historically did
 * `const body = await req.json().catch(() => null)` and then hand-rolled
 * `typeof`/`in` narrowing before touching the manager. This module gives that
 * narrowing a single `Schema` boundary: {@link decodeBody} decodes-or-rejects an
 * envelope, and {@link decodeBodyOrEmpty} does the same for endpoints that never
 * had a required-field 4xx (they silently defaulted a malformed/absent body to
 * `{}`) — that lenient behavior is preserved verbatim, not tightened.
 *
 * Modeling convention, deliberately light-touch (mirrors `client-command.ts`'s
 * `create`/`commission` treatment): a field the handler's *original* code
 * required (a bad/missing value produced a specific 4xx) is typed precisely
 * (`String`/`Boolean`/a small nested `Struct`) so a decode failure reproduces
 * that exact response. Every other field — optional, independently
 * `typeof`-narrowed downstream, or forwarded to a function outside this file's
 * scope — stays `Schema.optional(Schema.Unknown)`. This is intentional, not
 * under-modeling: those fields already have their own (unchanged) narrowing
 * code right after the decode, and re-typing them here would either duplicate
 * that logic or risk rejecting a request the original handler happily
 * defaulted. `Schema.Struct` still strips excess keys, so field-injection is
 * neutralized on every endpoint below regardless of how loosely a given field
 * is typed.
 *
 * These schemas are bespoke per-endpoint request shapes, not mirrors of a
 * `types.ts` interface, so (unlike `client-command.ts` / `federation-frame.ts`)
 * there is no compile-time drift guard here — there is no canonical type to
 * drift from.
 */
import { Result, Schema } from "effect";
import { formatDecodeIssue } from "./client-command.ts";

/** A rejected decode: a single-line, bounded reason suitable for a 4xx body or a log. */
export interface BodyDecodeError {
	readonly message: string;
}

/**
 * Validate an untrusted HTTP request body against `schema`. Returns the typed
 * body on success, or a bounded error message on failure. Never throws.
 */
export function decodeBody<A, I>(schema: Schema.Codec<A, I>, body: unknown): Result.Result<A, BodyDecodeError> {
	const r = Schema.decodeUnknownResult(schema)(body);
	if (Result.isFailure(r)) return Result.fail({ message: formatDecodeIssue(r.failure) });
	return Result.succeed(r.success);
}

/**
 * Same as {@link decodeBody}, but for endpoints whose original handler had no
 * required-field 4xx at all — a non-object/malformed body just meant every
 * field defaulted. Decode failure (the body isn't even struct-shaped) falls
 * back to `{}` instead of propagating an error, exactly matching that prior
 * silent-default behavior; a struct-shaped body with individually-mistyped
 * optional fields still decodes fine since those fields are `Schema.Unknown`.
 */
export function decodeBodyOrEmpty<A extends Record<string, unknown>, I>(schema: Schema.Codec<A, I>, body: unknown): A {
	const r = decodeBody(schema, body);
	return Result.isSuccess(r) ? r.success : ({} as A);
}

// ---------------------------------------------------------------------------
// WorkOS / org admin
// ---------------------------------------------------------------------------

/** POST /api/workos/join-requests/decide — `id` required, everything else soft. */
/** POST /api/projects — register a repo as a project. `repo` must be an ABSOLUTE path to a git
 *  worktree; the manager validates that (never resolved against the daemon's cwd). */
export const ProjectRegisterBodySchema = Schema.Struct({
	repo: Schema.String,
});

/** POST /api/harness-events — a foreign harness CLI's hook reporting its own session lifecycle
 *  (fleet-ide-bridge B03). Written by a shim on the operator's machine, so it is untrusted input
 *  like any other body: decoded, never cast. `cwd` grants nothing on its own — the route drops any
 *  cwd outside a registered project. */
export const HarnessEventBodySchema = Schema.Struct({
	harness: Schema.String,
	event: Schema.Literals(["start", "prompt", "attention", "stop"]),
	sessionId: Schema.String,
	cwd: Schema.String,
});

/** POST /api/answers — ask a question of a repo (R5). The unit that answers is an observer: it never
 *  commits and never lands, so `repo` grants read, not write. */
export const AskBodySchema = Schema.Struct({
	repo: Schema.String,
	question: Schema.String,
	model: Schema.optional(Schema.String),
	harness: Schema.optional(Schema.String),
});

export const JoinRequestDecideBodySchema = Schema.Struct({
	id: Schema.String,
	action: Schema.optional(Schema.Unknown),
});

/** PATCH /api/org — no required field; `renameOrg` accepts (and rejects) `""` itself. */
export const OrgPatchBodySchema = Schema.Struct({
	name: Schema.optional(Schema.Unknown),
});

/** POST /api/org/members/role, POST /api/org/members/remove — `userId` required. */
export const OrgMemberRoleBodySchema = Schema.Struct({
	userId: Schema.String,
	role: Schema.optional(Schema.Unknown),
});

/** POST /api/org/members/invite — `email` required. */
export const OrgMemberInviteBodySchema = Schema.Struct({
	email: Schema.String,
	role: Schema.optional(Schema.Unknown),
});

/** POST /api/org/join-policy — no required field (`policy` defaults to "approval"). */
export const OrgJoinPolicyBodySchema = Schema.Struct({
	policy: Schema.optional(Schema.Unknown),
});

// ---------------------------------------------------------------------------
// Push / settings
// ---------------------------------------------------------------------------

/** POST /api/push/subscribe — a W3C PushSubscriptionJSON; every field below is required
 *  (the original handler 400s on any one of them being missing/mistyped). */
export const PushSubscriptionBodySchema = Schema.Struct({
	endpoint: Schema.String,
	keys: Schema.Struct({
		p256dh: Schema.String,
		auth: Schema.String,
	}),
});

/** POST /api/settings/feature-flags — `key` and `enabled` both required; `isFeatureFlagKey`
 *  membership stays a post-decode business check (it's a runtime set, not a literal union). */
export const FeatureFlagBodySchema = Schema.Struct({
	key: Schema.String,
	enabled: Schema.Boolean,
});

/** POST /api/policy/rules — the full rule set (replace). Per-rule coercion/sanitization is a
 *  post-decode business check via `parsePolicyDoc` (drops malformed rules), so the wire schema only
 *  asserts the envelope shape: an object with a `rules` array. */
export const PolicyRulesBodySchema = Schema.Struct({
	rules: Schema.Array(Schema.Unknown),
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** POST /api/capability-sources — no field is unconditionally required (the handler's own
 *  "manifest or catalogId required" check runs post-decode); the schema's only job is to
 *  reject a non-object body with that same message. */
export const CapabilitySourceBodySchema = Schema.Struct({
	catalogId: Schema.optional(Schema.Unknown),
	manifest: Schema.optional(Schema.Unknown),
	name: Schema.optional(Schema.Unknown),
	url: Schema.optional(Schema.Unknown),
	trusted: Schema.optional(Schema.Unknown),
});

/** POST /api/capability-installs — `packId` required. */
export const CapabilityInstallBodySchema = Schema.Struct({
	packId: Schema.String,
	overrides: Schema.optional(Schema.Unknown),
	enable: Schema.optional(Schema.Unknown),
});

/** PATCH /api/capability-installs/:id — a free-form patch; no required field. */
export const CapabilityInstallPatchBodySchema = Schema.Struct({
	state: Schema.optional(Schema.Unknown),
	enabled: Schema.optional(Schema.Unknown),
	removed: Schema.optional(Schema.Unknown),
	rollback: Schema.optional(Schema.Unknown),
	upgradeToPackId: Schema.optional(Schema.Unknown),
	overrides: Schema.optional(Schema.Unknown),
});

/** POST /api/capability-installs/:id/run — no required field (the original fetch already
 *  defaulted a bad body to `{}`, not `null`). */
export const CapabilityInstallRunBodySchema = Schema.Struct({
	bindingKey: Schema.optional(Schema.Unknown),
	repo: Schema.optional(Schema.Unknown),
	prompt: Schema.optional(Schema.Unknown),
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** POST /api/features — `title` required. */
export const FeatureCreateBodySchema = Schema.Struct({
	title: Schema.String,
	repo: Schema.optional(Schema.Unknown),
	planDir: Schema.optional(Schema.Unknown),
});

/** POST /api/features/from-plan — `planDir` required. */
export const FeatureFromPlanBodySchema = Schema.Struct({
	planDir: Schema.String,
	repo: Schema.optional(Schema.Unknown),
	title: Schema.optional(Schema.Unknown),
});

/** POST /api/features/auto — `goal` required (non-empty-after-trim stays a post-decode check). */
export const FeatureAutoBodySchema = Schema.Struct({
	goal: Schema.String,
	title: Schema.optional(Schema.Unknown),
	repo: Schema.optional(Schema.Unknown),
	model: Schema.optional(Schema.Unknown),
});

/** PATCH /api/features/:id — a free-form patch; no required field. */
export const FeaturePatchBodySchema = Schema.Struct({
	repo: Schema.optional(Schema.Unknown),
	title: Schema.optional(Schema.Unknown),
	description: Schema.optional(Schema.Unknown),
	archived: Schema.optional(Schema.Unknown),
	stageOverride: Schema.optional(Schema.Unknown),
	category: Schema.optional(Schema.Unknown),
	acceptanceCriteria: Schema.optional(Schema.Unknown),
	decisions: Schema.optional(Schema.Unknown),
	relationships: Schema.optional(Schema.Unknown),
});

/** PUT /api/features/:id/assignees — `assignees` (a string[] of user identities) required. Each id
 *  is validated post-decode against the org roster (DB mode) or the operator identity (file mode);
 *  the schema only asserts the envelope is `{ assignees: string[] }`, rejecting a non-array body. */
export const AssigneesBodySchema = Schema.Struct({
	assignees: Schema.Array(Schema.String),
});

/** POST /api/features/:id/agents — either a `task` (creates+links a new agent) or an
 *  `agentId` (links/unlinks an existing one); neither is unconditionally required. */
export const FeatureAgentsLinkBodySchema = Schema.Struct({
	task: Schema.optional(Schema.Unknown),
	repo: Schema.optional(Schema.Unknown),
	name: Schema.optional(Schema.Unknown),
	agentId: Schema.optional(Schema.Unknown),
	unlink: Schema.optional(Schema.Unknown),
});

/** PATCH /api/features/:id/concerns — `file` required (trim-non-empty stays post-decode). */
export const FeatureConcernsPatchBodySchema = Schema.Struct({
	file: Schema.String,
	repo: Schema.optional(Schema.Unknown),
	status: Schema.optional(Schema.Unknown),
	blockedBy: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/answers — `file` required; `prompt`/`value` are checked (and
 *  trimmed) as a separate pair post-decode with their own "prompt and value required" 4xx. */
export const FeatureAnswersBodySchema = Schema.Struct({
	file: Schema.String,
	prompt: Schema.optional(Schema.Unknown),
	value: Schema.optional(Schema.Unknown),
	repo: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/land — no required field. */
export const FeatureLandBodySchema = Schema.Struct({
	force: Schema.optional(Schema.Unknown),
	reason: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/module — no required field. */
export const FeatureModuleBodySchema = Schema.Struct({
	repo: Schema.optional(Schema.Unknown),
	tickets: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/module/repair — no required field. */
export const FeatureModuleRepairBodySchema = Schema.Struct({
	repo: Schema.optional(Schema.Unknown),
	closeOrphans: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/plan-candidates — `planPath` and `summary` both required
 *  (trim-non-empty + the combined "planPath and summary required" message stay post-decode). */
export const PlanCandidateCreateBodySchema = Schema.Struct({
	planPath: Schema.String,
	summary: Schema.String,
	producerAgentId: Schema.optional(Schema.Unknown),
	runId: Schema.optional(Schema.Unknown),
	traceId: Schema.optional(Schema.Unknown),
	diffRef: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/plan-candidates/:id/(accept|reject|supersede) — no required field. */
export const PlanCandidateTransitionBodySchema = Schema.Struct({
	reason: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/plan-vote/call — no required field. `candidateId` is optional (absent ⇒
 *  the handler resolves the feature's current head "candidate"-state `PlanRevisionCandidate`). */
export const PlanVoteCallBodySchema = Schema.Struct({
	candidateId: Schema.optional(Schema.Unknown),
	deadlineMs: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/plan-vote/cast — `roundId` and `choice` both required (`choice` is
 *  further narrowed to "approve"|"reject" post-decode, mirroring every other loosely-typed-then-
 *  handler-checked string field in this file). */
export const PlanVoteCastBodySchema = Schema.Struct({
	roundId: Schema.String,
	choice: Schema.String,
});

/** POST /api/features/:id/annotations — `body`+`planPath` (nested inside the envelope) are
 *  jointly required via the existing `planAnnotationTarget` helper, which runs post-decode
 *  unchanged; nothing here is unconditionally required. */
export const AnnotationCreateBodySchema = Schema.Struct({
	body: Schema.optional(Schema.Unknown),
	planPath: Schema.optional(Schema.Unknown),
	lineStart: Schema.optional(Schema.Unknown),
	lineEnd: Schema.optional(Schema.Unknown),
	quote: Schema.optional(Schema.Unknown),
	blockId: Schema.optional(Schema.Unknown),
	/** Design-review section anchor (an H2 heading text) — additive, optional. */
	heading: Schema.optional(Schema.Unknown),
});

/** POST /api/features/:id/annotations/:id/send — no required field (`mode` defaults to "planner"). */
export const AnnotationSendBodySchema = Schema.Struct({
	mode: Schema.optional(Schema.Unknown),
	agentId: Schema.optional(Schema.Unknown),
});

// ---------------------------------------------------------------------------
// Federation / spawn / console / agents / tasks / comments
// ---------------------------------------------------------------------------

/** POST /api/federation/command — `to`/`cmd` are jointly required via a combined message that
 *  stays post-decode. `cmd` is an opaque `ClientCommand`-shaped payload relayed verbatim to a
 *  remote peer (which re-authorizes independently) — it MUST NOT be narrowed to a `Struct` here,
 *  since `Schema.Struct` strips unknown keys and would truncate the very command being forwarded. */
export const FederationCommandBodySchema = Schema.Struct({
	to: Schema.optional(Schema.Unknown),
	cmd: Schema.optional(Schema.Unknown),
});

/** POST /api/spawn — `prompt` required (empty-after-trim stays a post-decode check). `source` is
 *  optional observability-only provenance (e.g. "voice") threaded to `recordAudit`/audit.jsonl —
 *  `Schema.Struct` strips unknown keys, so without naming it here a caller-supplied `source` would
 *  be silently dropped before it ever reached the manager. */
export const SpawnBodySchema = Schema.Struct({
	prompt: Schema.String,
	profileId: Schema.optional(Schema.Unknown),
	source: Schema.optional(Schema.Unknown),
});

/** POST /api/console — no required field. */
export const ConsoleBodySchema = Schema.Struct({
	repo: Schema.optional(Schema.Unknown),
	model: Schema.optional(Schema.Unknown),
	profileId: Schema.optional(Schema.Unknown),
});

/** POST /api/agents/:id/land — no required field. */
export const AgentLandBodySchema = Schema.Struct({
	force: Schema.optional(Schema.Unknown),
	reason: Schema.optional(Schema.Unknown),
	message: Schema.optional(Schema.Unknown),
});

/** POST /api/agents/:id/mode — no required field at the schema level; `mode` validity is
 *  enforced downstream by the existing `validateRequestedMode`. */
export const AgentModeBodySchema = Schema.Struct({
	mode: Schema.optional(Schema.Unknown),
	reason: Schema.optional(Schema.Unknown),
});

/** POST /api/agents/:id/vision — no required field (`url` falls back to an env var). */
export const AgentVisionBodySchema = Schema.Struct({
	url: Schema.optional(Schema.Unknown),
});

/** POST /api/chat-attachments — `dataUrl` required (a `data:image/png;base64,...` payload; Feature
 *  2 D2, chat-attachment.ts). Mime/size/PNG-magic validation happens post-decode in
 *  `decodeChatAttachmentDataUrl` — this schema only asserts the envelope shape. */
export const ChatAttachmentCreateBodySchema = Schema.Struct({
	dataUrl: Schema.String,
});

/** POST /api/voice/token — no required field (`provider` defaults to `"openai"` downstream in
 *  `voice-token.ts`; an unknown provider id 400s post-decode, not here — the SSRF-doctrine closed
 *  switch lives in `mintVoiceToken`, not in schema validation). */
export const VoiceTokenBodySchema = Schema.Struct({
	provider: Schema.optional(Schema.Unknown),
});

/** PUT /api/org/voice-key — set/rotate the session org's voice provider key
 *  (plans/voice-db-mode/05-admin-endpoints.md). `apiKey` required: an empty PUT can never verify
 *  against anything, and the handler must reject before it ever reaches the store. `provider`
 *  defaults to `"openai"` downstream, mirroring `VoiceTokenBodySchema` — an unknown provider id
 *  400s post-decode in the handler, not here. */
export const OrgVoiceKeyBodySchema = Schema.Struct({
	apiKey: Schema.String,
	provider: Schema.optional(Schema.Unknown),
});

/** POST /api/org/voice/enabled — the synchronous kill switch (DESIGN.md "Kill switch" row).
 *  `enabled` required: there is no honest default for "on or off" the way other endpoints default
 *  an absent optional field. */
export const OrgVoiceEnabledBodySchema = Schema.Struct({
	enabled: Schema.Boolean,
	provider: Schema.optional(Schema.Unknown),
});

/** POST /api/tasks/:id/start — no required field (`repo` falls back to `process.cwd()`). */
export const TaskStartBodySchema = Schema.Struct({
	repo: Schema.optional(Schema.Unknown),
});

/** POST /api/comments — `subject` and `body` both required (non-empty-after-trim on `body`
 *  stays a post-decode check, combined into the same "subject and body required" message). */
export const CommentsCreateBodySchema = Schema.Struct({
	subject: Schema.String,
	body: Schema.String,
	repo: Schema.optional(Schema.Unknown),
	urgent: Schema.optional(Schema.Unknown),
});

/** POST /api/feedback/items — the (untyped) body is forwarded VERBATIM to
 *  `manager.submitFeedbackItem`, which owns its own validation; this schema only
 *  exists to narrow `campaignId` for the rate limiter, so it must not replace the
 *  raw body passed downstream. */
export const FeedbackItemsEnvelopeSchema = Schema.Struct({
	campaignId: Schema.optional(Schema.Unknown),
});
