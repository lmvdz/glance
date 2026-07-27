/**
 * Concern 02 — CallProjectionStore: every journal record type projects once, duplicate/replay is a
 * detected no-op, a seq gap is recorded and surfaced, decision cards fire on mint/terminal only, and
 * transcript retention is enforced (full/tails persist text, off persists a truthful redaction marker).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CallProjectionStore, type EmitVoiceDecisionCardInput } from "../src/voice-call-projection.ts";
import type { JournalEnvelope } from "../src/voice-call-journal.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "voice-projection-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function decisionEnvelope(seq: number, decision: Partial<JournalEnvelope["record"] extends { decision: infer D } ? D : never> & { id: string; state: string }): JournalEnvelope {
	return {
		seq,
		at: 1000 + seq,
		sessionId: "s1",
		record: { type: "decision", decision: { prompt: "Which name?", options: [{ index: 0, label: "Keep it", consequence: "no-op" }], requiresConfirmation: false, createdAt: 1, updatedAt: 1, ...decision } as never },
	};
}

function transcriptEnvelope(seq: number, turn: number, role: "user" | "assistant", text: string, final = true): JournalEnvelope {
	return { seq, at: 1000 + seq, sessionId: "s1", record: { type: "transcript", transcript: { role, text, turn, final } } };
}

function terminalEnvelope(seq: number, error: string | null = null): JournalEnvelope {
	return { seq, at: 1000 + seq, sessionId: "s1", record: { type: "terminal", error } };
}

describe("decision projection", () => {
	test("an open decision mints exactly one card, tagged 'mint'", async () => {
		const cards: EmitVoiceDecisionCardInput[] = [];
		const store = new CallProjectionStore(dir, { onDecisionCard: (c) => { cards.push(c); } });
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		expect(cards).toHaveLength(1);
		expect(cards[0]!.cardKind).toBe("mint");
		expect(store.decision("room-1", "d1")?.state).toBe("open");
	});

	test("awaiting-confirmation updates the mutable store but mints NO third card", async () => {
		const cards: EmitVoiceDecisionCardInput[] = [];
		const store = new CallProjectionStore(dir, { onDecisionCard: (c) => { cards.push(c); } });
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(1, { id: "d1", state: "awaiting-confirmation" }), "full");
		expect(cards).toHaveLength(1); // still just the mint card
		expect(store.decision("room-1", "d1")?.state).toBe("awaiting-confirmation");
	});

	test("a terminal state (answered) mints a second, terminal-tagged card", async () => {
		const cards: EmitVoiceDecisionCardInput[] = [];
		const store = new CallProjectionStore(dir, { onDecisionCard: (c) => { cards.push(c); } });
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(1, { id: "d1", state: "answered", resolution: { optionIndex: 0, label: "Keep it", source: "voice" } }), "full");
		expect(cards.map((c) => c.cardKind)).toEqual(["mint", "terminal"]);
		expect(store.decision("room-1", "d1")?.state).toBe("answered");
	});

	test("expired/cancelled/failed each mint their own terminal card", async () => {
		for (const state of ["expired", "cancelled", "failed"] as const) {
			const cards: EmitVoiceDecisionCardInput[] = [];
			const store = new CallProjectionStore(mkdtempSync(path.join(os.tmpdir(), "voice-projection-term-")), { onDecisionCard: (c) => { cards.push(c); } });
			await store.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
			await store.applyEnvelope("room-1", "call-1", decisionEnvelope(1, { id: "d1", state }), "full");
			expect(cards.map((c) => c.cardKind)).toEqual(["mint", "terminal"]);
		}
	});
});

describe("idempotent duplicate/replay", () => {
	test("re-applying the SAME envelope (seq) is a detected no-op — no second card, no mutation", async () => {
		const cards: EmitVoiceDecisionCardInput[] = [];
		const store = new CallProjectionStore(dir, { onDecisionCard: (c) => { cards.push(c); } });
		const envelope = decisionEnvelope(0, { id: "d1", state: "open" });
		const first = await store.applyEnvelope("room-1", "call-1", envelope, "full");
		const replay = await store.applyEnvelope("room-1", "call-1", envelope, "full");
		expect(first.status).toBe("applied-decision");
		expect(replay.status).toBe("duplicate");
		expect(cards).toHaveLength(1);
	});

	test("a full restart (fresh store instance, same stateDir) still refuses to re-apply an already-applied seq", async () => {
		const store1 = new CallProjectionStore(dir);
		await store1.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		const store2 = new CallProjectionStore(dir);
		const replay = await store2.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		expect(replay.status).toBe("duplicate");
	});

	test("re-tailing from byte 0 after a restart re-delivers every envelope, and every one collapses to a no-op past the durable cursor", async () => {
		const store1 = new CallProjectionStore(dir);
		await store1.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		await store1.applyEnvelope("room-1", "call-1", decisionEnvelope(1, { id: "d1", state: "answered", resolution: { optionIndex: 0, label: "Keep it", source: "voice" } }), "full");
		const store2 = new CallProjectionStore(dir);
		const outcomes = [];
		for (const seq of [0, 1]) {
			const env = seq === 0 ? decisionEnvelope(0, { id: "d1", state: "open" }) : decisionEnvelope(1, { id: "d1", state: "answered", resolution: { optionIndex: 0, label: "Keep it", source: "voice" } });
			outcomes.push((await store2.applyEnvelope("room-1", "call-1", env, "full")).status);
		}
		expect(outcomes).toEqual(["duplicate", "duplicate"]);
	});
});

describe("visible journal gap marker", () => {
	test("a seq jump is recorded with the exact missing count", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(0, { id: "d1", state: "open" }), "full");
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(5, { id: "d1", state: "answered", resolution: { optionIndex: 0, label: "Keep it", source: "voice" } }), "full");
		const gaps = store.gaps("room-1");
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ callId: "call-1", atSeq: 5, missingCount: 4 });
	});

	test("the transcript entry right after a gap carries a gapBefore marker", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(0, 0, "user", "hello"), "full");
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(3, 1, "assistant", "sure, one sec"), "full");
		const transcript = await store.transcript("call-1");
		expect(transcript).toHaveLength(2);
		expect(transcript[1]!.gapBefore).toEqual({ missingCount: 2 });
	});

	test("no gap is recorded for the first envelope ever seen (no prior cursor to compare against)", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", decisionEnvelope(7, { id: "d1", state: "open" }), "full");
		expect(store.gaps("room-1")).toHaveLength(0);
	});
});

describe("transcript retention", () => {
	test("full: text is persisted verbatim", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(0, 0, "user", "check the auth module"), "full");
		const transcript = await store.transcript("call-1");
		expect(transcript[0]).toMatchObject({ role: "user", text: "check the auth module" });
		expect(transcript[0]!.redacted).toBeUndefined();
	});

	test("tails: text is persisted verbatim too (OMP itself already bounds tails at the source)", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(0, 0, "user", "hi"), "tails");
		const transcript = await store.transcript("call-1");
		expect(transcript[0]!.text).toBe("hi");
	});

	test("off: text is never persisted — a truthful redaction marker instead", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(0, 0, "user", "should never be stored"), "off");
		const transcript = await store.transcript("call-1");
		expect(transcript[0]!.text).toBeUndefined();
		expect(transcript[0]!.redacted).toBe(true);
		const raw = await require("node:fs/promises").readFile(path.join(dir, "voice-transcripts", "call-1.jsonl"), "utf8");
		expect(raw).not.toContain("should never be stored");
	});

	test("streaming replace-by-turn collapses to the latest write per (role, turn)", async () => {
		const store = new CallProjectionStore(dir);
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(0, 0, "user", "che", false), "full");
		await store.applyEnvelope("room-1", "call-1", transcriptEnvelope(1, 0, "user", "check the auth module", true), "full");
		const transcript = await store.transcript("call-1");
		expect(transcript).toHaveLength(1);
		expect(transcript[0]!.text).toBe("check the auth module");
	});
});

describe("terminal and artifact records project once", () => {
	test("terminal returns the error verbatim", async () => {
		const store = new CallProjectionStore(dir);
		const outcome = await store.applyEnvelope("room-1", "call-1", terminalEnvelope(0, "boom"), "full");
		expect(outcome).toEqual({ status: "applied-terminal", error: "boom" });
	});

	test("artifact returns the artifact record for the caller to snapshot", async () => {
		const store = new CallProjectionStore(dir);
		const outcome = await store.applyEnvelope("room-1", "call-1", { seq: 0, at: 1, sessionId: "s1", record: { type: "artifact", artifact: { path: "report.md", status: "ready" } } }, "full");
		expect(outcome).toEqual({ status: "applied-artifact", artifact: { path: "report.md", status: "ready" } });
	});
});
