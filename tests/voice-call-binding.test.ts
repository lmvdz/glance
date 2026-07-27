/**
 * Concern 02 — durable call-binding record: attach persistence, pinned-identity rejection on port
 * reuse, and rehydration from a fresh store instance pointed at the same state dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CallBindingStore } from "../src/voice-call-binding.ts";

function tmpDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "voice-binding-"));
}

let dir: string;
beforeEach(() => {
	dir = tmpDir();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("beginConnecting / attachBroker / pinSession happy path", () => {
	test("persists a connecting binding before the broker ever answers", () => {
		const store = new CallBindingStore(dir);
		const binding = store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		expect(binding.state).toBe("connecting");
		expect(binding.callId).toBeUndefined();
		// Rehydrating a FRESH store instance from the same dir sees the connecting binding — proof it
		// was durably persisted synchronously, not merely held in memory.
		const rehydrated = new CallBindingStore(dir);
		expect(rehydrated.get("room-1")?.state).toBe("connecting");
	});

	test("attachBroker then pinSession moves connecting → live and pins the session id", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		const attached = store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1" });
		expect(attached.state).toBe("connecting");
		expect(attached.callId).toBe("call-1");
		const pinned = store.pinSession("room-1", "live-session-abc");
		expect(pinned.ok).toBe(true);
		if (pinned.ok) {
			expect(pinned.binding.state).toBe("live");
			expect(pinned.binding.sessionId).toBe("live-session-abc");
		}
	});

	test("controlToken never appears on the redacted view", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "super-secret" });
		const binding = store.get("room-1")!;
		expect(binding.controlToken).toBe("super-secret");
		const { redactBinding } = require("../src/voice-call-binding.ts") as typeof import("../src/voice-call-binding.ts");
		const view = redactBinding(binding);
		expect((view as Record<string, unknown>).controlToken).toBeUndefined();
		expect(JSON.stringify(view)).not.toContain("super-secret");
	});
});

describe("pinned-identity rejection on port reuse", () => {
	test("a second, different sessionId for the same still-open binding is refused, not adopted", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1" });
		const first = store.pinSession("room-1", "session-A");
		expect(first.ok).toBe(true);
		const second = store.pinSession("room-1", "session-B");
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.reason).toBe("port-reused");
			// The binding's PINNED identity must be untouched by the rejected attempt.
			expect(second.binding.sessionId).toBe("session-A");
		}
		expect(store.get("room-1")?.sessionId).toBe("session-A");
	});

	test("the SAME sessionId reconnecting (transient socket loss recovery) is accepted, not rejected", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1" });
		store.pinSession("room-1", "session-A");
		store.markDegraded("room-1");
		const reconnect = store.pinSession("room-1", "session-A");
		expect(reconnect.ok).toBe(true);
		if (reconnect.ok) expect(reconnect.binding.state).toBe("live");
	});
});

describe("at most one active call per channel", () => {
	test("beginConnecting refuses when a non-ended binding already exists", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		expect(() => store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" })).toThrow();
	});

	test("beginConnecting succeeds again once the prior binding ended", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		store.markEnded("room-1", "operator-ended");
		expect(() => store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" })).not.toThrow();
	});
});

describe("markEnded idempotency", () => {
	test("ending an already-ended binding keeps the FIRST honest terminal reason", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		store.markEnded("room-1", "terminal", "boom");
		const second = store.markEnded("room-1", "operator-ended");
		expect(second.terminalReason).toBe("terminal");
		expect(second.terminalError).toBe("boom");
	});
});

describe("rehydration from a fresh store instance", () => {
	test("every field a browser refresh needs survives a restart", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "tails", resumeSessionId: "sess-9" });
		store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1" });
		store.pinSession("room-1", "session-A");
		store.updateJournalCursor("room-1", 42);

		const rehydrated = new CallBindingStore(dir);
		const binding = rehydrated.get("room-1")!;
		expect(binding.state).toBe("live");
		expect(binding.sessionId).toBe("session-A");
		expect(binding.callId).toBe("call-1");
		expect(binding.retention).toBe("tails");
		expect(binding.resumeSessionId).toBe("sess-9");
		expect(binding.lastJournalSeq).toBe(42);
	});

	test("a corrupt voice-calls.json rehydrates to no bindings, not a crash", () => {
		const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "voice-calls.json"), "{not json");
		expect(() => new CallBindingStore(dir)).not.toThrow();
		expect(new CallBindingStore(dir).list()).toEqual([]);
	});
});

describe("markDegraded / markLiveAgain", () => {
	test("degraded then recovered clears degradedSince/degradedReason", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1" });
		store.pinSession("room-1", "session-A");
		const degraded = store.markDegraded("room-1");
		expect(degraded.state).toBe("degraded");
		expect(degraded.degradedReason).toBe("socket-loss");
		const recovered = store.markLiveAgain("room-1");
		expect(recovered.state).toBe("live");
		expect(recovered.degradedSince).toBeUndefined();
	});
});

describe("CRITICAL 3 — attachBroker's sessionRoot override, and retentionMismatch", () => {
	test("attachBroker's `sessionRoot`, when given, replaces beginConnecting's provisional guess", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/daemon-guess", retention: "full" });
		const attached = store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1", sessionRoot: "/tmp/broker-root" });
		expect(attached.sessionRoot).toBe("/tmp/broker-root");
	});

	test("attachBroker without `sessionRoot` leaves beginConnecting's guess untouched (back-compat with an older caller)", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/daemon-guess", retention: "full" });
		const attached = store.attachBroker("room-1", { callId: "call-1", port: 8788, bridgeUrl: "ws://127.0.0.1:8788", journalPath: "/tmp/j.jsonl", controlToken: "tok-1" });
		expect(attached.sessionRoot).toBe("/tmp/daemon-guess");
	});

	test("setRetentionMismatch sets, persists across a fresh store instance, and clears", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		const mismatched = store.setRetentionMismatch("room-1", { expected: "full", reported: "tails" });
		expect(mismatched.retentionMismatch).toEqual({ expected: "full", reported: "tails" });

		// Durable, not just in-memory — a fresh store instance pointed at the same dir sees it too.
		const rehydrated = new CallBindingStore(dir);
		expect(rehydrated.get("room-1")?.retentionMismatch).toEqual({ expected: "full", reported: "tails" });

		const cleared = store.setRetentionMismatch("room-1", undefined);
		expect(cleared.retentionMismatch).toBeUndefined();
	});

	test("setRetentionMismatch is a no-op write when the value is unchanged (no updatedAt churn)", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		const first = store.setRetentionMismatch("room-1", { expected: "full", reported: "tails" });
		const second = store.setRetentionMismatch("room-1", { expected: "full", reported: "tails" });
		expect(second.updatedAt).toBe(first.updatedAt);
	});

	test("a corrupt retentionMismatch shape on disk is dropped, not trusted verbatim", () => {
		const store = new CallBindingStore(dir);
		store.beginConnecting("room-1", { ownerActorId: "operator", sessionRoot: "/tmp/proj", retention: "full" });
		const { writeFileSync, readFileSync } = require("node:fs") as typeof import("node:fs");
		const raw = JSON.parse(readFileSync(path.join(dir, "voice-calls.json"), "utf8"));
		raw["room-1"].retentionMismatch = { expected: "full", reported: "not-a-real-mode" };
		writeFileSync(path.join(dir, "voice-calls.json"), JSON.stringify(raw));
		const rehydrated = new CallBindingStore(dir);
		expect(rehydrated.get("room-1")?.retentionMismatch).toBeUndefined();
	});
});
