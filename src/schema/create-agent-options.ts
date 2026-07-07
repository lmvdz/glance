/**
 * Runtime validation for the two heavy `ClientCommand` payloads — the
 * `CreateAgentOptions` carried by `{ type: "create" }` and the `CommissionSpec`
 * carried by `{ type: "commission" }`.
 *
 * Both arrive over the same three untrusted ingress points as the rest of
 * `ClientCommand` (dashboard WebSocket, `POST /api/command`, a federation peer),
 * and until now were passed through untouched via `Schema.Unknown`. Phase 1
 * (PR #81) validated only that the payload key was present. This module
 * deep-models the user/wire-facing fields so a hostile or malformed payload
 * (missing `repo`, `repo: 42`, a bogus `approvalMode`, an injected extra key) is
 * rejected before it reaches `manager.create()` / `manager.commission()`.
 *
 * Design note — `Schema.Struct` STRIPS keys it does not list, so EVERY field the
 * canonical type allows must be represented or it would be silently dropped from
 * the decoded value. Two classes of field:
 *   1. User/wire-facing fields (repo, name, model, approvalMode, sandbox, …) are
 *      modeled faithfully with concrete schemas — these legitimately arrive from
 *      a browser or a peer and are worth validating.
 *   2. Fields set ONLY by internal restore / fan-out code paths and NEVER over
 *      the wire (workflowState, subagents, workflowGraph, parentId, parentNodeId,
 *      branchIndex, adopted, cold, traceId, bypassCap, scopeSource) are modeled
 *      as `Schema.optional(Schema.Unknown)`: present-if-present (not stripped),
 *      but their deep nested types are left opaque on purpose.
 *
 * `types.ts` stays the SOURCE OF TRUTH. The compile-time drift guards at the
 * bottom fail `tsc` if `CreateAgentOptions` / `CommissionSpec` gains a field that
 * is not representable here, so the schemas can never silently fall behind.
 */
import { Schema } from "effect";
import type { CommissionSpec, CreateAgentOptions } from "../types.ts";

/** `types.ts#ApprovalMode`. */
const ApprovalModeSchema = Schema.Literals(["always-ask", "write", "yolo"]);
/** `types.ts#ThinkingLevel`. */
const ThinkingLevelSchema = Schema.Literals(["minimal", "low", "medium", "high", "xhigh"]);
/** `types.ts#ExecutionRole`. */
const ExecutionRoleSchema = Schema.Literals(["tester", "observer"]);
/** `types.ts#ScopeSource`. */
const ScopeSourceSchema = Schema.Literals(["inferred", "operator"]);
/** `autonomy.ts#AutonomyMode`. */
const AutonomyModeSchema = Schema.Literals(["observe", "assist", "autodrive"]);
/** `CreateAgentOptions#verifyMode` / `VerifySpec#mode`. */
const VerifyModeSchema = Schema.Literals(["verify", "tdd", "observe"]);
/** `CreateAgentOptions#runtime`. */
const RuntimeSchema = Schema.Literals(["omp", "acp"]);

/**
 * `types.ts#IssueRef` — the work item shown in the command center. `priority`
 * collapses to `string` in the canonical type (`… | string`), so it is modeled
 * as a plain string here.
 */
const IssueRefSchema = Schema.Struct({
	id: Schema.String,
	identifier: Schema.optional(Schema.String),
	name: Schema.String,
	state: Schema.optional(Schema.String),
	priority: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	projectId: Schema.optional(Schema.String),
	blockedBy: Schema.optional(Schema.Array(Schema.String)),
	noAutoDispatch: Schema.optional(Schema.Boolean),
	requires: Schema.optional(Schema.Array(Schema.String)),
	owns: Schema.optional(Schema.Array(Schema.String)),
	produces: Schema.optional(Schema.Array(Schema.String)),
	scopeSource: Schema.optional(ScopeSourceSchema),
});

/** `types.ts#SandboxConfig` — containerized execution. */
const SandboxConfigSchema = Schema.Struct({
	image: Schema.String,
	workdir: Schema.optional(Schema.String),
	mountWorktree: Schema.optional(Schema.Boolean),
	runArgs: Schema.optional(Schema.Array(Schema.String)),
});

/** `types.ts#FlueMemberConfig` — flue-service worker invocation. */
const FlueMemberConfigSchema = Schema.Struct({
	dir: Schema.String,
	workflow: Schema.String,
	target: Schema.Literals(["node", "cloudflare"]),
});

/** `types.ts#McpServerSpec` — an MCP server a profile (or a direct create request) attaches. */
const McpServerSpecSchema = Schema.Struct({
	name: Schema.String,
	type: Schema.Literals(["stdio", "sse", "http"]),
	command: Schema.optional(Schema.String),
	args: Schema.optional(Schema.Array(Schema.String)),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	url: Schema.optional(Schema.String),
	headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	enabled: Schema.optional(Schema.Boolean),
});

/**
 * `types.ts#CreateAgentOptions`. User/wire-facing fields modeled concretely;
 * internal restore/fan-out plumbing modeled as `optional(Unknown)` (see file
 * header).
 */
export const CreateAgentOptionsSchema = Schema.Struct({
	// ── user/wire-facing ──────────────────────────────────────────────────────
	repo: Schema.String,
	name: Schema.optional(Schema.String),
	runtime: Schema.optional(RuntimeSchema),
	// harness/bin select the driver (harness-registry) — wire-facing since `glance add --harness`
	// posts a `create` command; without these here Schema.Struct would strip them before create().
	harness: Schema.optional(Schema.String),
	bin: Schema.optional(Schema.String),
	branch: Schema.optional(Schema.String),
	existingPath: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	profileId: Schema.optional(Schema.String),
	approvalMode: Schema.optional(ApprovalModeSchema),
	task: Schema.optional(Schema.String),
	appendSystemPrompt: Schema.optional(Schema.String),
	thinking: Schema.optional(ThinkingLevelSchema),
	issue: Schema.optional(IssueRefSchema),
	featureId: Schema.optional(Schema.String),
	workflow: Schema.optional(Schema.String),
	flue: Schema.optional(FlueMemberConfigSchema),
	verify: Schema.optional(Schema.String),
	verifyMode: Schema.optional(VerifyModeSchema),
	executionRole: Schema.optional(ExecutionRoleSchema),
	autonomyMode: Schema.optional(AutonomyModeSchema),
	sandbox: Schema.optional(SandboxConfigSchema),
	autoRoute: Schema.optional(Schema.Boolean),
	requires: Schema.optional(Schema.Array(Schema.String)),
	owns: Schema.optional(Schema.Array(Schema.String)),
	produces: Schema.optional(Schema.Array(Schema.String)),
	track: Schema.optional(Schema.Boolean),
	mcp: Schema.optional(Schema.Array(McpServerSpecSchema)),
	// ── internal restore / fan-out only: never over the wire, kept opaque ─────
	workflowState: Schema.optional(Schema.Unknown),
	parentId: Schema.optional(Schema.Unknown),
	parentNodeId: Schema.optional(Schema.Unknown),
	branchIndex: Schema.optional(Schema.Unknown),
	subagents: Schema.optional(Schema.Unknown),
	workflowGraph: Schema.optional(Schema.Unknown),
	scopeSource: Schema.optional(Schema.Unknown),
	bypassCap: Schema.optional(Schema.Unknown),
	adopted: Schema.optional(Schema.Unknown),
	cold: Schema.optional(Schema.Unknown),
	traceId: Schema.optional(Schema.Unknown),
});

/** The decoded type. Intentionally equal-or-wider than `CreateAgentOptions`. */
export type SchemaCreateAgentOptions = typeof CreateAgentOptionsSchema.Type;

/**
 * `types.ts#CommissionSpec` — the "job description" handed to the commissioning
 * loop. `model` is `string | false`; opaque sub-configs (`accept.payload`,
 * `accept.expect`) are passed through.
 */
export const CommissionSpecSchema = Schema.Struct({
	name: Schema.String,
	purpose: Schema.String,
	model: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
	capabilities: Schema.optional(Schema.Array(Schema.String)),
	deployTarget: Schema.optional(Schema.Literals(["node", "cloudflare"])),
	workflowBody: Schema.optional(Schema.String),
	// `{ payload: unknown; expect?: Record<string, unknown> }` — opaque by design.
	accept: Schema.optional(Schema.Unknown),
});

/** The decoded type. Intentionally equal-or-wider than `CommissionSpec`. */
export type SchemaCommissionSpec = typeof CommissionSpecSchema.Type;

/**
 * Compile-time drift guards. The canonical `types.ts` interfaces must remain
 * assignable to the schemas' decoded types — i.e. every field of the source of
 * truth is representable here. Add a field in `types.ts` that this schema cannot
 * hold and the corresponding line stops type-checking, failing `tsc`.
 */
type _CreateDrift = CreateAgentOptions extends SchemaCreateAgentOptions ? true : never;
const _createDrift: _CreateDrift = true;
type _CommissionDrift = CommissionSpec extends SchemaCommissionSpec ? true : never;
const _commissionDrift: _CommissionDrift = true;
// Reference the guards so `noUnusedLocals` keeps them (they exist purely to type-check).
export const _payloadDriftGuards = [_createDrift, _commissionDrift] as const;
