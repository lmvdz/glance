import { expect, test } from "bun:test";
import { Result } from "effect";
import { decodeClientCommand } from "../src/schema/client-command.ts";

function ok(input: unknown) {
	const r = decodeClientCommand(input);
	if (Result.isFailure(r)) throw new Error(`expected success, got failure: ${r.failure.message}`);
	return r.success;
}
function rejected(input: unknown): boolean {
	return Result.isFailure(decodeClientCommand(input));
}

test("accepts every scalar variant and preserves fields", () => {
	expect(ok({ type: "prompt", id: "a", message: "hi" })).toEqual({ type: "prompt", id: "a", message: "hi" });
	expect(ok({ type: "prompt", id: "a", message: "hi", clientTurnId: "t1", displayText: "shown" })).toEqual({
		type: "prompt",
		id: "a",
		message: "hi",
		clientTurnId: "t1",
		displayText: "shown",
	});
	expect(ok({ type: "set-model", id: "a", model: "opus" })).toEqual({ type: "set-model", id: "a", model: "opus" });
	expect(ok({ type: "answer", id: "a", requestId: "r", value: "yes" })).toEqual({ type: "answer", id: "a", requestId: "r", value: "yes" });
	expect(ok({ type: "interrupt", id: "a" })).toEqual({ type: "interrupt", id: "a" });
	expect(ok({ type: "kill", id: "a" })).toEqual({ type: "kill", id: "a" });
	expect(ok({ type: "restart", id: "a" })).toEqual({ type: "restart", id: "a" });
	expect(ok({ type: "fork", id: "a" })).toEqual({ type: "fork", id: "a" });
	expect(ok({ type: "fork", id: "a", seq: 3 })).toEqual({ type: "fork", id: "a", seq: 3 });
	expect(ok({ type: "remove", id: "a" })).toEqual({ type: "remove", id: "a" });
	expect(ok({ type: "remove", id: "a", deleteWorktree: true })).toEqual({ type: "remove", id: "a", deleteWorktree: true });
	expect(ok({ type: "message", to: "b", text: "hey" })).toEqual({ type: "message", to: "b", text: "hey" });
	expect(ok({ type: "snapshot" })).toEqual({ type: "snapshot" });
	expect(ok({ type: "subscribe", id: "a" })).toEqual({ type: "subscribe", id: "a" });
	expect(ok({ type: "set-mode", id: "a", mode: "autodrive" })).toEqual({ type: "set-mode", id: "a", mode: "autodrive" });
	expect(ok({ type: "set-mode", id: "a", mode: "observe", reason: "paused" })).toEqual({ type: "set-mode", id: "a", mode: "observe", reason: "paused" });
});

test("create: a realistic full options payload decodes and preserves every modeled field", () => {
	const options = {
		repo: "/r",
		name: "x",
		runtime: "acp" as const,
		branch: "squad/x",
		existingPath: "/tmp/wt",
		model: "opus",
		profileId: "p1",
		approvalMode: "yolo" as const,
		task: "do it",
		appendSystemPrompt: "be terse",
		thinking: "high" as const,
		issue: { id: "i1", name: "Ship it", identifier: "OMPSQ-1", priority: "high", requires: ["src/a"], scopeSource: "operator" as const },
		featureId: "f1",
		workflow: "graph.fabro",
		flue: { dir: "/w", workflow: "extract", target: "node" as const },
		verify: "bun test",
		verifyMode: "tdd" as const,
		executionRole: "tester" as const,
		autonomyMode: "autodrive" as const,
		sandbox: { image: "img", workdir: "/work", mountWorktree: false, runArgs: ["--network=none"] },
		autoRoute: true,
		requires: ["src/a"],
		owns: ["src/b"],
		produces: ["src/c"],
		track: true,
	};
	// Every modeled field round-trips unchanged.
	expect(ok({ type: "create", options })).toEqual({ type: "create", options });
});

test("create: internal restore/fan-out fields are kept as opaque passthrough (not stripped)", () => {
	const options = {
		repo: "/r",
		// These are set only by internal restore/fan-out code, never over the wire.
		workflowState: { cursor: 3, nested: { deep: [1, 2] } },
		parentId: "p",
		parentNodeId: "n",
		branchIndex: 2,
		subagents: [{ id: "s1" }],
		workflowGraph: { nodes: [] },
		scopeSource: "operator",
		bypassCap: true,
		adopted: true,
		cold: true,
		traceId: "t",
	};
	// optional(Unknown) preserves the value verbatim rather than dropping the key.
	expect(ok({ type: "create", options })).toEqual({ type: "create", options });
});

test("create: strips keys that are not part of CreateAgentOptions (field-injection defense)", () => {
	const decoded = ok({ type: "create", options: { repo: "/r", role: "admin", orgId: "other" } }) as { options: Record<string, unknown> };
	expect(decoded.options).toEqual({ repo: "/r" });
	expect("role" in decoded.options).toBe(false);
});

test("create: rejects a payload with a bad field type or bad enum value", () => {
	expect(rejected({ type: "create", options: { repo: 42 } })).toBe(true); // repo must be a string
	expect(rejected({ type: "create", options: {} })).toBe(true); // repo is required
	expect(rejected({ type: "create", options: { repo: "/r", approvalMode: "root" } })).toBe(true); // bad ApprovalMode
	expect(rejected({ type: "create", options: { repo: "/r", runtime: "wasm" } })).toBe(true); // bad runtime
	expect(rejected({ type: "create", options: { repo: "/r", verifyMode: "yolo" } })).toBe(true); // bad verifyMode
	expect(rejected({ type: "create", options: { repo: "/r", thinking: "ultra" } })).toBe(true); // bad ThinkingLevel
	expect(rejected({ type: "create", options: { repo: "/r", requires: "src/a" } })).toBe(true); // requires must be string[]
	expect(rejected({ type: "create", options: { repo: "/r", sandbox: { workdir: "/work" } } })).toBe(true); // sandbox.image required
	expect(rejected({ type: "create", options: { repo: "/r", track: "yes" } })).toBe(true); // track must be boolean
});

test("commission: valid specs decode (model string | false) and preserve fields", () => {
	const noLlm = { name: "extract-emails", purpose: "pull emails", capabilities: ["read"], model: false as const, deployTarget: "node" as const };
	expect(ok({ type: "commission", spec: noLlm })).toEqual({ type: "commission", spec: noLlm });

	const llm = { name: "triage", purpose: "route issues", model: "opus", workflowBody: "return {}" };
	expect(ok({ type: "commission", spec: llm })).toEqual({ type: "commission", spec: llm });
});

test("commission: rejects missing required or mistyped fields", () => {
	expect(rejected({ type: "commission", spec: { purpose: "x" } })).toBe(true); // no name
	expect(rejected({ type: "commission", spec: { name: "x" } })).toBe(true); // no purpose
	expect(rejected({ type: "commission", spec: { name: "x", purpose: "y", model: 5 } })).toBe(true); // model not string|false
	expect(rejected({ type: "commission", spec: { name: "x", purpose: "y", model: true } })).toBe(true); // model true is not allowed
	expect(rejected({ type: "commission", spec: { name: "x", purpose: "y", capabilities: "read" } })).toBe(true); // capabilities must be string[]
	expect(rejected({ type: "commission", spec: { name: "x", purpose: "y", deployTarget: "aws" } })).toBe(true); // bad deployTarget
});

test("strips injected excess keys (field-injection defense)", () => {
	// A hostile client tacks on authority-shaped keys; they must not survive decode.
	const decoded = ok({ type: "kill", id: "a", role: "admin", origin: "local", orgId: "other-tenant" }) as Record<string, unknown>;
	expect(decoded).toEqual({ type: "kill", id: "a" });
	expect("role" in decoded).toBe(false);
	expect("origin" in decoded).toBe(false);
});

test("rejects unknown / missing discriminant", () => {
	expect(rejected({ type: "sudo", id: "a" })).toBe(true);
	expect(rejected({ id: "a", message: "hi" })).toBe(true);
	expect(rejected({ type: 5, id: "a" })).toBe(true);
});

test("rejects non-object inputs", () => {
	expect(rejected(null)).toBe(true);
	expect(rejected(undefined)).toBe(true);
	expect(rejected("prompt")).toBe(true);
	expect(rejected(42)).toBe(true);
	expect(rejected([{ type: "kill", id: "a" }])).toBe(true);
});

test("rejects missing / mistyped required fields", () => {
	expect(rejected({ type: "prompt", id: "a" })).toBe(true); // no message
	expect(rejected({ type: "prompt", id: 1, message: "hi" })).toBe(true); // id not a string
	expect(rejected({ type: "answer", id: "a", requestId: "r" })).toBe(true); // no value
	expect(rejected({ type: "message", to: "b" })).toBe(true); // no text
	expect(rejected({ type: "fork", id: "a", seq: "3" })).toBe(true); // seq not a number
	expect(rejected({ type: "create" })).toBe(true); // no options
	expect(rejected({ type: "commission" })).toBe(true); // no spec
});

test("rejects set-mode with an out-of-range autonomy mode", () => {
	expect(rejected({ type: "set-mode", id: "a", mode: "root" })).toBe(true);
	expect(rejected({ type: "set-mode", id: "a", mode: "autodrive-plus" })).toBe(true);
	expect(ok({ type: "set-mode", id: "a", mode: "assist" }).type).toBe("set-mode");
});

test("failure carries a bounded, single-line message", () => {
	const r = decodeClientCommand({ type: "prompt", id: "a" });
	expect(Result.isFailure(r)).toBe(true);
	if (Result.isFailure(r)) {
		expect(r.failure.message.length).toBeLessThanOrEqual(200);
		expect(r.failure.message).not.toContain("\n");
		expect(r.failure.message.length).toBeGreaterThan(0);
	}
});
