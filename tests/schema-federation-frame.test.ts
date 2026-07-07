import { expect, test } from "bun:test";
import { Result } from "effect";
import { decodeFederationFrame } from "../src/schema/federation-frame.ts";

function ok(input: unknown) {
	const r = decodeFederationFrame(input);
	if (Result.isFailure(r)) throw new Error(`expected success, got failure: ${r.failure.message}`);
	return r.success;
}
function rejected(input: unknown): boolean {
	return Result.isFailure(decodeFederationFrame(input));
}

const actor = { id: "bob@co.com", displayName: "Bob", origin: "remote" as const };

test("accepts a presence frame and preserves opaque agent DTOs untouched", () => {
	const presence = {
		operator: actor,
		availability: "active",
		host: "laptop",
		// AgentDTOs are passed through verbatim — deep fields must survive.
		agents: [{ id: "a1", name: "coder", nested: { deep: [1, 2] }, cost: 3.2 }],
		updatedAt: 1000,
	};
	expect(ok({ kind: "presence", presence })).toEqual({ kind: "presence", presence });
});

test("accepts a command frame with a valid embedded ClientCommand", () => {
	const frame = { kind: "command", cmd: { type: "prompt", id: "a", message: "hi" }, actor, ip: "100.64.0.1", to: "me", cmdId: "c1" };
	expect(ok(frame)).toEqual(frame);
});

test("drops a command frame whose embedded command is malformed", () => {
	expect(rejected({ kind: "command", cmd: { type: "sudo", id: "a" }, actor })).toBe(true);
	expect(rejected({ kind: "command", cmd: { type: "prompt", id: "a" }, actor })).toBe(true); // no message
	expect(rejected({ kind: "command", cmd: "not-an-object", actor })).toBe(true);
});

test("accepts command-ack, message, and leases frames", () => {
	expect(ok({ kind: "command-ack", cmdId: "c1", to: "me", from: "bob", outcome: "applied" }).kind).toBe("command-ack");
	expect(rejected({ kind: "command-ack", cmdId: "c1", to: "me", outcome: "yolo" })).toBe(true); // bad outcome
	expect(ok({ kind: "message", from: actor, text: "gm", ts: 5 })).toEqual({ kind: "message", from: actor, text: "gm", ts: 5 });
	const lease = { id: "l1", repo: "r", file: "src/a.ts", operator: "bob", session: "s", host: "h", since: 1, heartbeat: 2 };
	expect(ok({ kind: "leases", repoId: "r", operator: actor, leases: [lease] })).toEqual({ kind: "leases", repoId: "r", operator: actor, leases: [lease] });
	expect(rejected({ kind: "leases", repoId: "r", operator: actor, leases: [{ id: "l1" }] })).toBe(true); // incomplete lease
});

test("validates actor shape and strips injected keys", () => {
	expect(rejected({ kind: "message", from: { id: "x", origin: "root" }, text: "t", ts: 1 })).toBe(true); // bad origin
	expect(rejected({ kind: "message", from: { origin: "remote" }, text: "t", ts: 1 })).toBe(true); // no id
	// An injected key on the actor is stripped, not preserved.
	const decoded = ok({ kind: "message", from: { id: "x", origin: "remote", role: "admin", evil: 1 }, text: "t", ts: 1 });
	expect((decoded as { from: Record<string, unknown> }).from.evil).toBeUndefined();
});

test("rejects unknown / missing kind and non-objects", () => {
	expect(rejected({ kind: "takeover", data: 1 })).toBe(true);
	expect(rejected({ presence: {} })).toBe(true);
	expect(rejected(null)).toBe(true);
	expect(rejected("presence")).toBe(true);
	expect(rejected([{ kind: "message", from: actor, text: "t", ts: 1 }])).toBe(true);
});
