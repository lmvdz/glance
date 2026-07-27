/**
 * Concern 02 — JournalTailer: complete-line tailing, partial-write tolerance, and re-tail from byte 0
 * after a simulated restart (a fresh tailer instance over the same file re-emits everything — the
 * consumer's own (callId, seq) idempotency, exercised in voice-call-projection.test.ts, is what makes
 * that safe).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JournalTailer, parseJournalLine } from "../src/voice-call-journal.ts";

function tmpDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "voice-journal-"));
}

let dir: string;
let file: string;
beforeEach(() => {
	dir = tmpDir();
	file = path.join(dir, "journal.jsonl");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function line(seq: number, record: unknown): string {
	return `${JSON.stringify({ seq, at: 1000 + seq, sessionId: "s1", record })}\n`;
}

describe("parseJournalLine", () => {
	test("parses each record type", () => {
		const d = parseJournalLine(JSON.stringify({ seq: 0, at: 1, sessionId: "s1", record: { type: "decision", decision: { id: "d1", prompt: "p", options: [], requiresConfirmation: false, state: "open", createdAt: 1, updatedAt: 1 } } }));
		expect(d?.record.type).toBe("decision");
		const t = parseJournalLine(JSON.stringify({ seq: 1, at: 1, sessionId: "s1", record: { type: "transcript", transcript: { role: "user", text: "hi", turn: 0, final: true } } }));
		expect(t?.record.type).toBe("transcript");
		const a = parseJournalLine(JSON.stringify({ seq: 2, at: 1, sessionId: "s1", record: { type: "artifact", artifact: { path: "x.md", status: "ready" } } }));
		expect(a?.record.type).toBe("artifact");
		const term = parseJournalLine(JSON.stringify({ seq: 3, at: 1, sessionId: "s1", record: { type: "terminal", error: null } }));
		expect(term?.record.type).toBe("terminal");
	});

	test("malformed/torn lines return undefined, never throw", () => {
		expect(parseJournalLine("not json")).toBeUndefined();
		expect(parseJournalLine("{}")).toBeUndefined();
		expect(parseJournalLine(JSON.stringify({ seq: 0, at: 1, sessionId: "s1", record: { type: "mystery" } }))).toBeUndefined();
	});
});

describe("JournalTailer.poll", () => {
	test("applies complete lines in order and reports the missing-file case distinctly", async () => {
		const applied: number[] = [];
		const tailer = new JournalTailer({ path: file, onEnvelope: (e) => { applied.push(e.seq); } });
		const missing = await tailer.poll();
		expect(missing.status).toBe("missing");

		writeFileSync(file, line(0, { type: "terminal", error: null }) + line(1, { type: "terminal", error: null }));
		const ok = await tailer.poll();
		expect(ok.status).toBe("ok");
		if (ok.status === "ok") expect(ok.applied).toBe(2);
		expect(applied).toEqual([0, 1]);
	});

	test("a partial trailing line (write still in flight) is held back until it's whole", async () => {
		const applied: number[] = [];
		const tailer = new JournalTailer({ path: file, onEnvelope: (e) => { applied.push(e.seq); } });
		writeFileSync(file, line(0, { type: "terminal", error: null }));
		// Append a line with NO trailing newline yet — simulates a write in flight.
		appendFileSync(file, JSON.stringify({ seq: 1, at: 1, sessionId: "s1", record: { type: "terminal", error: null } }));
		await tailer.poll();
		expect(applied).toEqual([0]); // the partial line must NOT have been parsed yet

		appendFileSync(file, "\n");
		await tailer.poll();
		expect(applied).toEqual([0, 1]);
	});

	test("only new bytes are re-read across polls (no duplicate emission within one process)", async () => {
		const applied: number[] = [];
		const tailer = new JournalTailer({ path: file, onEnvelope: (e) => { applied.push(e.seq); } });
		writeFileSync(file, line(0, { type: "terminal", error: null }));
		await tailer.poll();
		await tailer.poll(); // nothing new
		appendFileSync(file, line(1, { type: "terminal", error: null }));
		await tailer.poll();
		expect(applied).toEqual([0, 1]);
	});

	test("a restarted tailer (fresh instance, offset 0) re-emits everything — idempotency is the consumer's job", async () => {
		writeFileSync(file, line(0, { type: "terminal", error: null }) + line(1, { type: "terminal", error: null }));
		const first: number[] = [];
		await new JournalTailer({ path: file, onEnvelope: (e) => { first.push(e.seq); } }).poll();
		expect(first).toEqual([0, 1]);
		const second: number[] = [];
		await new JournalTailer({ path: file, onEnvelope: (e) => { second.push(e.seq); } }).poll();
		expect(second).toEqual([0, 1]);
	});

	test("an unparseable line is reported via onError and does not stop later lines from applying", async () => {
		const applied: number[] = [];
		const errors: unknown[] = [];
		writeFileSync(file, "garbage not json\n" + line(1, { type: "terminal", error: null }));
		const tailer = new JournalTailer({ path: file, onEnvelope: (e) => { applied.push(e.seq); }, onError: (e) => errors.push(e) });
		await tailer.poll();
		expect(applied).toEqual([1]);
		expect(errors.length).toBeGreaterThan(0);
	});

	test("onMissing does NOT fire while the file has never existed yet (OMP hasn't written its first record)", async () => {
		let missingFired = 0;
		const tailer = new JournalTailer({ path: file, onEnvelope: () => {}, onMissing: () => { missingFired++; } });
		await tailer.poll();
		await tailer.poll();
		expect(missingFired).toBe(0);
	});

	test("onMissing fires once the file has been observed to exist and then vanishes", async () => {
		let missingFired = 0;
		const tailer = new JournalTailer({ path: file, onEnvelope: () => {}, onMissing: () => { missingFired++; } });
		writeFileSync(file, line(0, { type: "terminal", error: null }));
		await tailer.poll(); // observes the file existing
		rmSync(file);
		await tailer.poll(); // now it's gone
		expect(missingFired).toBe(1);
	});

	test("start()/stop() drive polling on an interval without leaking a handle", async () => {
		writeFileSync(file, "");
		const applied: number[] = [];
		const tailer = new JournalTailer({ path: file, intervalMs: 10, onEnvelope: (e) => { applied.push(e.seq); } });
		tailer.start();
		appendFileSync(file, line(0, { type: "terminal", error: null }));
		await new Promise((r) => setTimeout(r, 60));
		tailer.stop();
		expect(applied).toEqual([0]);
	});
});
