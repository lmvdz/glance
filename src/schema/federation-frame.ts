/**
 * Runtime validation for the untrusted `FederationFrame` wire.
 *
 * A federation peer controls every byte of the frames it sends to us over the
 * coordinator socket, yet `handleFrame` decoded them with `JSON.parse(data) as
 * FederationFrame` — no shape check — before fanning them out to the roster,
 * lease view, chat, and (via the `command` kind) `applyCommand`. Phase 1 hardened
 * only the embedded command; this completes the wire: the whole frame is decoded
 * or dropped.
 *
 * Security note: this validates *shape*, not *authority*. A peer's claimed
 * `role`/`origin` on an actor is still stripped downstream by `remoteCommandActor`
 * (OMPSQ-162) — the schema models `Actor` faithfully so valid frames decode, and
 * the command kind reuses {@link ClientCommandSchema} so a malformed command sinks
 * the whole frame.
 *
 * Opaque view payloads — `OperatorPresence.agents` (AgentDTO[], ~140 lines) — are
 * preserved untouched via `Schema.Unknown`; deep-modeling AgentDTO is a follow-up.
 * `federation.ts#FederationFrame` stays the source of truth, guarded at compile
 * time below.
 */
import { Result, Schema } from "effect";
import type { CommandAck, FederationFrame } from "../federation.ts";
import type { LeaseEntry } from "../leases.ts";
import type { Actor, OperatorPresence } from "../types.ts";
import { ClientCommandSchema, formatDecodeIssue } from "./client-command.ts";

/** `types.ts#Actor`. Authority fields (`role`/`origin`) are modeled but NOT trusted — see file header. */
const ActorSchema = Schema.Struct({
	id: Schema.String,
	displayName: Schema.optional(Schema.String),
	origin: Schema.Literals(["local", "remote", "agent"]),
	role: Schema.optional(Schema.Literals(["viewer", "operator", "admin"])),
	orgId: Schema.optional(Schema.String),
});
type _ActorGuard = Actor extends typeof ActorSchema.Type ? true : never;
const _actorGuard: _ActorGuard = true;

/** `types.ts#OperatorPresence`. `agents` (AgentDTO[]) passed through untouched. */
const OperatorPresenceSchema = Schema.Struct({
	operator: ActorSchema,
	availability: Schema.Literals(["active", "away", "offline"]),
	host: Schema.optional(Schema.String),
	agents: Schema.Array(Schema.Unknown),
	updatedAt: Schema.Number,
});
type _PresenceGuard = OperatorPresence extends typeof OperatorPresenceSchema.Type ? true : never;
const _presenceGuard: _PresenceGuard = true;

/** `leases.ts#LeaseEntry` — small and fully modeled. */
const LeaseEntrySchema = Schema.Struct({
	id: Schema.String,
	repo: Schema.String,
	file: Schema.String,
	operator: Schema.String,
	session: Schema.String,
	host: Schema.String,
	since: Schema.Number,
	heartbeat: Schema.Number,
});
type _LeaseGuard = LeaseEntry extends typeof LeaseEntrySchema.Type ? true : never;
const _leaseGuard: _LeaseGuard = true;

/** The untrusted federation wire. One struct per `FederationFrame` kind. */
export const FederationFrameSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("presence"), presence: OperatorPresenceSchema }),
	Schema.Struct({
		kind: Schema.Literal("command"),
		cmd: ClientCommandSchema,
		actor: ActorSchema,
		ip: Schema.optional(Schema.String),
		to: Schema.optional(Schema.String),
		cmdId: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("command-ack"),
		cmdId: Schema.String,
		to: Schema.String,
		from: Schema.optional(Schema.String),
		outcome: Schema.Literals(["applied", "denied", "error"] satisfies readonly CommandAck["outcome"][]),
		detail: Schema.optional(Schema.String),
	}),
	Schema.Struct({ kind: Schema.Literal("message"), from: ActorSchema, text: Schema.String, ts: Schema.Number }),
	Schema.Struct({ kind: Schema.Literal("leases"), repoId: Schema.String, operator: ActorSchema, leases: Schema.Array(LeaseEntrySchema) }),
]);

type SchemaFederationFrame = typeof FederationFrameSchema.Type;

// Compile-time drift guard: every FederationFrame kind/field must be representable
// here. Add a kind in federation.ts without mirroring it and `tsc` breaks.
type _DriftGuard = FederationFrame extends SchemaFederationFrame ? true : never;
const _driftGuard: _DriftGuard = true;
type _KindFwd = FederationFrame["kind"] extends SchemaFederationFrame["kind"] ? true : never;
type _KindBwd = SchemaFederationFrame["kind"] extends FederationFrame["kind"] ? true : never;
const _kindsMatch: [_KindFwd, _KindBwd] = [true, true];

const decodeFrame = Schema.decodeUnknownResult(FederationFrameSchema);

export interface FederationFrameDecodeError {
	readonly message: string;
}

/**
 * Validate an untrusted value as a {@link FederationFrame}. Returns the typed
 * frame on success (re-narrowed — the envelope and all kinds are validated; the
 * command is validated via the ClientCommand schema; opaque `agents` are
 * preserved verbatim), or a bounded error message. Never throws.
 */
export function decodeFederationFrame(input: unknown): Result.Result<FederationFrame, FederationFrameDecodeError> {
	const r = decodeFrame(input);
	if (Result.isFailure(r)) return Result.fail({ message: formatDecodeIssue(r.failure) });
	return Result.succeed(r.success as FederationFrame);
}
