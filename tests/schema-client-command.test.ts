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

test("create/commission validate the envelope and pass deep payloads through untouched", () => {
	const options = { repo: "/r", name: "x", task: "do it", model: "opus", sandbox: { image: "img", runArgs: ["--network=none"] }, requires: ["src/a"], nested: { deep: [1, 2, 3] } };
	expect(ok({ type: "create", options })).toEqual({ type: "create", options });

	const spec = { name: "extract-emails", purpose: "pull emails", capabilities: ["read"], model: false };
	expect(ok({ type: "commission", spec })).toEqual({ type: "commission", spec });
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
