import { expect, test } from "bun:test";
import { Result } from "effect";
import { decodeHostToolCall, decodeResponseFrame } from "../src/schema/agent-host-frame.ts";

function okResp(input: unknown) {
	const r = decodeResponseFrame(input);
	if (Result.isFailure(r)) throw new Error(`expected success: ${r.failure.message}`);
	return r.success;
}
function okTool(input: unknown) {
	const r = decodeHostToolCall(input);
	if (Result.isFailure(r)) throw new Error(`expected success: ${r.failure.message}`);
	return r.success;
}

test("response: accepts valid frames and preserves opaque data", () => {
	expect(okResp({ type: "response", command: "list", success: true })).toEqual({ type: "response", command: "list", success: true });
	const data = { nested: { rows: [1, 2, 3] } };
	expect(okResp({ type: "response", id: "r1", command: "state", success: true, data })).toEqual({ type: "response", id: "r1", command: "state", success: true, data });
	expect(okResp({ type: "response", command: "x", success: false, error: "boom" }).error).toBe("boom");
});

test("response: rejects missing command / non-boolean success / wrong type", () => {
	expect(Result.isFailure(decodeResponseFrame({ type: "response", success: true }))).toBe(true);
	expect(Result.isFailure(decodeResponseFrame({ type: "response", command: "x", success: "yes" }))).toBe(true);
	expect(Result.isFailure(decodeResponseFrame({ type: "host_tool_call", command: "x", success: true }))).toBe(true);
});

test("host_tool_call: accepts valid frames and passes arguments through", () => {
	const args = { path: "src/a.ts", opts: { deep: [1] } };
	expect(okTool({ type: "host_tool_call", id: "a", toolCallId: "tc1", toolName: "read_file", arguments: args })).toEqual({
		type: "host_tool_call",
		id: "a",
		toolCallId: "tc1",
		toolName: "read_file",
		arguments: args,
	});
});

test("host_tool_call: rejects missing/mistyped fields — never executes garbage", () => {
	expect(Result.isFailure(decodeHostToolCall({ type: "host_tool_call", id: "a", toolCallId: "tc1", arguments: {} }))).toBe(true); // no toolName
	expect(Result.isFailure(decodeHostToolCall({ type: "host_tool_call", id: "a", toolCallId: "tc1", toolName: 5, arguments: {} }))).toBe(true); // toolName not string
	expect(Result.isFailure(decodeHostToolCall("not-an-object"))).toBe(true);
	expect(Result.isFailure(decodeHostToolCall(null))).toBe(true);
});

test("strips injected excess keys on both frames", () => {
	const resp = okResp({ type: "response", command: "x", success: true, evil: "payload" }) as Record<string, unknown>;
	expect("evil" in resp).toBe(false);
	const tool = okTool({ type: "host_tool_call", id: "a", toolCallId: "t", toolName: "n", arguments: {}, injected: 1 }) as Record<string, unknown>;
	expect("injected" in tool).toBe(false);
});
