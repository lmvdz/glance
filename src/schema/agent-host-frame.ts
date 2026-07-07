/**
 * Runtime validation for the state-affecting frames the agent-host emits to the
 * daemon over its stdio/socket protocol.
 *
 * Both `RpcAgent` (`rpc-agent.ts`) and `SandboxAgentDriver` (`sandbox-agent-driver.ts`)
 * read newline-delimited JSON frames and, in `handleLine`, `switch (frame.type)`
 * then `frame as ResponseFrame` / `frame as HostToolCallFrame` with no shape check.
 * With units now runnable on six different harnesses behind the driver seam
 * (omp/pi/claude-code/codex/opencode/gemini), a driver that emits a malformed
 * frame would flow straight through — a bad `host_tool_call` in particular
 * reaches `onHostTool`, which *executes* a tool. This validates the two frames
 * that mutate daemon state; the open-ended `event` passthrough (the `default`
 * switch arm) and the third-party `extension_ui_request` payload are unchanged.
 *
 * These schemas are the single source of truth for the two frame types — both
 * drivers import the derived types from here, replacing their copy-pasted local
 * definitions. Opaque payloads (`arguments`, `data`) pass through via
 * `Schema.Unknown`.
 */
import { Result, Schema } from "effect";
import { formatDecodeIssue } from "./client-command.ts";

/** A reply to a daemon→host command. Resolves/rejects the matching pending promise. */
export const ResponseFrameSchema = Schema.Struct({
	type: Schema.Literal("response"),
	id: Schema.optional(Schema.String),
	command: Schema.String,
	success: Schema.Boolean,
	data: Schema.optional(Schema.Unknown),
	error: Schema.optional(Schema.String),
});
export type ResponseFrame = typeof ResponseFrameSchema.Type;

/** A host-side tool invocation needing a result — drives `onHostTool` (tool execution). */
export const HostToolCallFrameSchema = Schema.Struct({
	type: Schema.Literal("host_tool_call"),
	id: Schema.String,
	toolCallId: Schema.String,
	toolName: Schema.String,
	arguments: Schema.Unknown,
});
export type HostToolCallFrame = typeof HostToolCallFrameSchema.Type;

const decodeResponse = Schema.decodeUnknownResult(ResponseFrameSchema);
const decodeHostTool = Schema.decodeUnknownResult(HostToolCallFrameSchema);

export interface FrameDecodeError {
	readonly message: string;
}

/** Validate a `response` frame. Never throws. */
export function decodeResponseFrame(input: unknown): Result.Result<ResponseFrame, FrameDecodeError> {
	const r = decodeResponse(input);
	if (Result.isFailure(r)) return Result.fail({ message: formatDecodeIssue(r.failure) });
	return Result.succeed(r.success);
}

/** Validate a `host_tool_call` frame before it reaches tool execution. Never throws. */
export function decodeHostToolCall(input: unknown): Result.Result<HostToolCallFrame, FrameDecodeError> {
	const r = decodeHostTool(input);
	if (Result.isFailure(r)) return Result.fail({ message: formatDecodeIssue(r.failure) });
	return Result.succeed(r.success);
}
