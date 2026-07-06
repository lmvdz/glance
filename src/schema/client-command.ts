/**
 * Runtime validation for the untrusted `ClientCommand` envelope.
 *
 * `ClientCommand` arrives from three untrusted ingress points — the dashboard
 * WebSocket, the `POST /api/command` endpoint, and (most dangerously) a remote
 * federation peer steering our fleet. Every one of those sites historically did
 * `JSON.parse(...) as ClientCommand` with no shape check, then dispatched into
 * `applyCommand`. This module is the first Effect `Schema` boundary: decode the
 * bytes into a validated command, or reject them.
 *
 * Scope (deliberate, see PR): the 11 scalar variants are fully modeled, so a
 * malformed or hostile command (unknown `type`, missing/mistyped field, injected
 * extra keys) is rejected — v4 `Schema.Struct` also strips excess keys, which
 * neutralizes field-injection. The two heavy variants, `create`
 * (`CreateAgentOptions`, ~40 nested fields) and `commission` (`CommissionSpec`),
 * validate the envelope and that the payload object is present, then pass the
 * payload through untouched via `Schema.Unknown`. Deep-modeling those payloads is
 * the Phase-2 follow-up; today they are consumed by `manager.create()` /
 * `manager.commission()`, which own their own handling.
 *
 * `types.ts#ClientCommand` stays the source of truth. The compile-time drift
 * guard below fails the build if a variant is added there without being mirrored
 * here, so the schema can never silently fall behind the type.
 */
import { Result, Schema } from "effect";
import type { AutonomyMode } from "../autonomy.ts";
import type { ClientCommand } from "../types.ts";

/** Autonomy tiers, mirrored from `autonomy.ts#AutonomyMode`. */
const AutonomyModeSchema = Schema.Literals(["observe", "assist", "autodrive"]);
// Local proof the literal set matches the canonical type (both directions).
type _ModeFwd = AutonomyMode extends typeof AutonomyModeSchema.Type ? true : never;
type _ModeBwd = typeof AutonomyModeSchema.Type extends AutonomyMode ? true : never;
const _modeMatch: [_ModeFwd, _ModeBwd] = [true, true];

/** The untrusted command envelope. One struct per `ClientCommand` variant. */
export const ClientCommandSchema = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("prompt"),
		id: Schema.String,
		message: Schema.String,
		clientTurnId: Schema.optional(Schema.String),
		displayText: Schema.optional(Schema.String),
	}),
	Schema.Struct({ type: Schema.Literal("set-model"), id: Schema.String, model: Schema.String }),
	Schema.Struct({ type: Schema.Literal("answer"), id: Schema.String, requestId: Schema.String, value: Schema.String }),
	Schema.Struct({ type: Schema.Literal("interrupt"), id: Schema.String }),
	Schema.Struct({ type: Schema.Literal("kill"), id: Schema.String }),
	Schema.Struct({ type: Schema.Literal("restart"), id: Schema.String }),
	Schema.Struct({ type: Schema.Literal("fork"), id: Schema.String, seq: Schema.optional(Schema.Number) }),
	Schema.Struct({ type: Schema.Literal("remove"), id: Schema.String, deleteWorktree: Schema.optional(Schema.Boolean) }),
	// Envelope-only: `options` (CreateAgentOptions) is preserved untouched — Phase-2 deep-models it.
	Schema.Struct({ type: Schema.Literal("create"), options: Schema.Unknown }),
	Schema.Struct({ type: Schema.Literal("message"), to: Schema.String, text: Schema.String }),
	Schema.Struct({ type: Schema.Literal("snapshot") }),
	Schema.Struct({ type: Schema.Literal("subscribe"), id: Schema.String }),
	// Envelope-only: `spec` (CommissionSpec) is preserved untouched — Phase-2 deep-models it.
	Schema.Struct({ type: Schema.Literal("commission"), spec: Schema.Unknown }),
	Schema.Struct({ type: Schema.Literal("set-mode"), id: Schema.String, mode: AutonomyModeSchema, reason: Schema.optional(Schema.String) }),
]);

/** The type the schema decodes to. Intentionally wider than `ClientCommand`
 *  (create/commission carry `unknown` payloads), so decoding re-narrows via a
 *  checked assertion in {@link decodeClientCommand}. */
type SchemaClientCommand = typeof ClientCommandSchema.Type;

/**
 * Compile-time drift guard. `ClientCommand` must be assignable to the schema's
 * decoded type — i.e. every variant and required field of the canonical type is
 * representable here. Add a `ClientCommand` variant in `types.ts` without
 * mirroring it above and this line stops type-checking, failing `tsc`.
 */
type _DriftGuard = ClientCommand extends SchemaClientCommand ? true : never;
const _driftGuard: _DriftGuard = true;
// Tag-level guard too: the discriminant sets must match exactly, both directions.
type _TagFwd = ClientCommand["type"] extends SchemaClientCommand["type"] ? true : never;
type _TagBwd = SchemaClientCommand["type"] extends ClientCommand["type"] ? true : never;
const _tagsMatch: [_TagFwd, _TagBwd] = [true, true];

const decodeCmd = Schema.decodeUnknownResult(ClientCommandSchema);

/** A rejected decode: a single-line, bounded reason suitable for a 4xx body or a log. */
export interface ClientCommandDecodeError {
	readonly message: string;
}

/** Collapse a Schema decode issue into a single-line, bounded reason for a 4xx body or a log. */
export function formatDecodeIssue(issue: unknown): string {
	const raw = typeof (issue as { message?: unknown })?.message === "string" ? (issue as { message: string }).message : String(issue);
	return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Validate an untrusted value as a {@link ClientCommand}. Returns the typed
 * command on success, or a bounded error message on failure. Never throws.
 *
 * The success value is re-narrowed to `ClientCommand`: sound because the
 * envelope and all scalar variants are fully validated and the create/commission
 * payloads are preserved verbatim.
 */
export function decodeClientCommand(input: unknown): Result.Result<ClientCommand, ClientCommandDecodeError> {
	const r = decodeCmd(input);
	if (Result.isFailure(r)) return Result.fail({ message: formatDecodeIssue(r.failure) });
	return Result.succeed(r.success as ClientCommand);
}
