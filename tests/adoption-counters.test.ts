/**
 * Adoption counters (plans/daily-dogfood-engine/02) — the numbers the adoption gate reads must be
 * computed honestly: UTC-day bucketing two machines can't disagree on, session-vs-prompt
 * granularity that doesn't double-count ACP's receipt-per-turn shape, and torn/foreign JSONL lines
 * dropped instead of NaN-bucketed. The by-day functions are pure; `computeAdoptionCounters` is
 * exercised against a real scratch state dir with all three seeded sources.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AdoptionCounters,
	casualSessionsByDay,
	computeAdoptionCounters,
	isAdoptionCounters,
	isCasualAgentId,
	isCasualSessionName,
	mergeAdoptionCounters,
	promptsByDay,
	pushTapsByDay,
	summarizeAdoption,
	utcDayOf,
} from "../src/adoption-counters.ts";
import type { RunReceipt, TransitionEntry } from "../src/types.ts";

const D1_LATE = Date.UTC(2026, 6, 15, 23, 59, 59, 999); // 2026-07-15, last ms
const D2_EARLY = Date.UTC(2026, 6, 16, 0, 0, 0, 1); // 2026-07-16, first ms
const D2_NOON = Date.UTC(2026, 6, 16, 12, 0, 0);

function receipt(over: Partial<RunReceipt> = {}): RunReceipt {
	return {
		agentId: "chat-abc-1-dead",
		name: "chat",
		repo: "/r",
		runId: "r1",
		startedAt: D2_NOON,
		status: "idle",
		toolCalls: 0,
		toolTally: {},
		filesTouched: [],
		traceId: "t",
		harness: "claude-code",
		...over,
	} as RunReceipt;
}

function transition(over: Partial<TransitionEntry> = {}): TransitionEntry {
	return { agentId: "chat-abc-1-dead", from: "idle", to: "working", reason: "turn-progress", at: D2_NOON, seq: crypto.randomUUID(), ...over };
}

// ── the casual-marking convention ────────────────────────────────────────────────────────────────

test("casual = the console-lane 'chat' convention, by name and by id prefix", () => {
	expect(isCasualSessionName("chat")).toBe(true);
	expect(isCasualSessionName("voice-loop")).toBe(false);
	expect(isCasualSessionName(undefined)).toBe(false);
	expect(isCasualAgentId("chat-mdcw1-1-ab12cd34")).toBe(true); // newAgentId("chat") shape
	expect(isCasualAgentId("agent-1")).toBe(false);
	expect(isCasualAgentId(undefined)).toBe(false);
});

// ── UTC-day bucketing ────────────────────────────────────────────────────────────────────────────

test("utcDayOf buckets by UTC calendar day, splitting exactly at midnight", () => {
	expect(utcDayOf(D1_LATE)).toBe("2026-07-15");
	expect(utcDayOf(D2_EARLY)).toBe("2026-07-16");
});

// ── casual sessions/day ──────────────────────────────────────────────────────────────────────────

test("one session with many receipts on one day counts ONCE (ACP finalizes a receipt per turn)", () => {
	const receipts = [receipt({ runId: "r1" }), receipt({ runId: "r2", startedAt: D2_NOON + 60_000 }), receipt({ runId: "r3", startedAt: D2_NOON + 120_000 })];
	expect(casualSessionsByDay(receipts)).toEqual({ "2026-07-16": 1 });
});

test("a session active across the midnight boundary counts on both days", () => {
	const receipts = [receipt({ startedAt: D1_LATE }), receipt({ runId: "r2", startedAt: D2_EARLY })];
	expect(casualSessionsByDay(receipts)).toEqual({ "2026-07-15": 1, "2026-07-16": 1 });
});

test("non-casual receipts and torn/foreign lines never count", () => {
	const receipts = [
		receipt({ agentId: "unit-1", name: "fix-the-gate" }), // fleet unit
		receipt({ startedAt: Number.NaN }), // torn line survived JSON.parse
		receipt({ startedAt: undefined as unknown as number }), // foreign shape
	];
	expect(casualSessionsByDay(receipts)).toEqual({});
});

test("two distinct casual sessions on one day are two", () => {
	const receipts = [receipt(), receipt({ agentId: "chat-def-2-beef" })];
	expect(casualSessionsByDay(receipts)).toEqual({ "2026-07-16": 2 });
});

// ── prompts/day ──────────────────────────────────────────────────────────────────────────────────

test("a prompt is a transition into working from idle OR input — nothing else", () => {
	const transitions = [
		transition(), // idle→working: a prompt
		transition({ from: "input", at: D2_NOON + 1 }), // answered pending then turn start: a prompt
		transition({ from: "starting", at: D2_NOON + 2 }), // boot, not a prompt
		transition({ from: "working", to: "idle", at: D2_NOON + 3 }), // turn END
		transition({ from: "idle", to: "input", at: D2_NOON + 4 }), // pending raised
	];
	expect(promptsByDay(transitions)).toEqual({ "2026-07-16": 2 });
});

test("denied transitions never happened, and non-casual agents never count", () => {
	const transitions = [
		transition({ denied: true }),
		transition({ agentId: "unit-1", at: D2_NOON + 1 }), // fleet unit
	];
	expect(promptsByDay(transitions)).toEqual({});
});

test("the receipt-derived casual set catches ids the chat- prefix alone would miss", () => {
	const transitions = [transition({ agentId: "renamed-77" })];
	expect(promptsByDay(transitions)).toEqual({}); // prefix alone: not casual
	expect(promptsByDay(transitions, new Set(["renamed-77"]))).toEqual({ "2026-07-16": 1 });
});

test("prompts bucket by UTC day across midnight", () => {
	const transitions = [transition({ at: D1_LATE }), transition({ at: D2_EARLY })];
	expect(promptsByDay(transitions)).toEqual({ "2026-07-15": 1, "2026-07-16": 1 });
});

// ── push taps/day ────────────────────────────────────────────────────────────────────────────────

test("every tap entry is one tap; invalid timestamps are dropped, never NaN-bucketed", () => {
	const taps = [
		{ ts: D1_LATE, agentId: "chat-a" },
		{ ts: D2_EARLY, agentId: "chat-a" },
		{ ts: Number.NaN, agentId: "chat-a" },
		{ ts: 0, agentId: "chat-a" },
	];
	expect(pushTapsByDay(taps)).toEqual({ "2026-07-15": 1, "2026-07-16": 1 });
});

// ── merge + summary ──────────────────────────────────────────────────────────────────────────────

test("mergeAdoptionCounters sums per day across managers", () => {
	const a: AdoptionCounters = { casualSessionsByDay: { "2026-07-16": 1 }, promptsByDay: { "2026-07-16": 3 }, pushTapsByDay: {} };
	const b: AdoptionCounters = { casualSessionsByDay: { "2026-07-16": 2, "2026-07-15": 1 }, promptsByDay: {}, pushTapsByDay: { "2026-07-16": 1 } };
	expect(mergeAdoptionCounters([a, b])).toEqual({
		casualSessionsByDay: { "2026-07-16": 3, "2026-07-15": 1 },
		promptsByDay: { "2026-07-16": 3 },
		pushTapsByDay: { "2026-07-16": 1 },
	});
	expect(mergeAdoptionCounters([])).toEqual({ casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {} });
});

test("summarizeAdoption reads today + a trailing 7-UTC-day window (day 7 is out)", () => {
	const now = D2_NOON;
	const days = Array.from({ length: 8 }, (_, i) => utcDayOf(now - i * 86_400_000));
	const counters: AdoptionCounters = {
		casualSessionsByDay: Object.fromEntries(days.map((d) => [d, 1])), // 8 days seeded, 7 in window
		promptsByDay: { [days[0]]: 4, [days[6]]: 2, [days[7]]: 100 }, // day 7 must NOT count
		pushTapsByDay: { [days[1]]: 1 },
	};
	const s = summarizeAdoption(counters, now);
	expect(s.day).toBe("2026-07-16");
	expect(s.sessions).toBe(1);
	expect(s.sessions7).toBe(7);
	expect(s.prompts).toBe(4);
	expect(s.prompts7).toBe(6);
	expect(s.pushTaps).toBe(0);
	expect(s.pushTaps7).toBe(1);
});

// ── the trust-boundary shape guard ───────────────────────────────────────────────────────────────

test("isAdoptionCounters accepts the real shape and rejects impostors", () => {
	expect(isAdoptionCounters({ casualSessionsByDay: {}, promptsByDay: { "2026-07-16": 1 }, pushTapsByDay: {} })).toBe(true);
	expect(isAdoptionCounters(null)).toBe(false);
	expect(isAdoptionCounters([])).toBe(false); // noFleet answers []
	expect(isAdoptionCounters({ casualSessionsByDay: {}, promptsByDay: {} })).toBe(false); // missing field
	expect(isAdoptionCounters({ casualSessionsByDay: { d: "1" }, promptsByDay: {}, pushTapsByDay: {} })).toBe(false); // non-numeric
});

// ── computeAdoptionCounters against a real scratch state dir ─────────────────────────────────────

function scratchStateDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "adoption-counters-"));
}

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("computeAdoptionCounters loads all three durable sources and counts them", async () => {
	const dir = scratchStateDir();
	mkdirSync(path.join(dir, "receipts"), { recursive: true });
	writeFileSync(path.join(dir, "receipts", "chat-abc-1-dead.jsonl"), jsonl([receipt(), receipt({ runId: "r2", startedAt: D2_NOON + 1 })]));
	writeFileSync(path.join(dir, "receipts", "unit-1.jsonl"), jsonl([receipt({ agentId: "unit-1", name: "fix-the-gate" })]));
	writeFileSync(path.join(dir, "transitions.jsonl"), jsonl([transition(), transition({ at: D2_NOON + 1 }), transition({ agentId: "unit-1", at: D2_NOON + 2 })]));
	writeFileSync(path.join(dir, "push-taps.jsonl"), jsonl([{ ts: D2_NOON, agentId: "chat-abc-1-dead" }]));

	expect(await computeAdoptionCounters(dir)).toEqual({
		casualSessionsByDay: { "2026-07-16": 1 },
		promptsByDay: { "2026-07-16": 2 },
		pushTapsByDay: { "2026-07-16": 1 },
	});
});

test("an empty state dir answers honest zeros, not a throw", async () => {
	expect(await computeAdoptionCounters(scratchStateDir())).toEqual({ casualSessionsByDay: {}, promptsByDay: {}, pushTapsByDay: {} });
});

test("live rings fold in without double-counting what already spooled to disk", async () => {
	const dir = scratchStateDir();
	const t1 = transition();
	const tapOnDisk = { ts: D2_NOON, agentId: "chat-abc-1-dead" };
	writeFileSync(path.join(dir, "transitions.jsonl"), jsonl([t1]));
	writeFileSync(path.join(dir, "push-taps.jsonl"), jsonl([tapOnDisk]));

	// The ring holds BOTH the already-spooled entries and ones whose fire-and-forget append hasn't
	// landed yet — the GET /api/adoption read-your-write case.
	const counters = await computeAdoptionCounters(dir, {
		transitions: [t1, transition({ at: D2_NOON + 5 })],
		pushTaps: [tapOnDisk, { ts: D2_NOON + 5, agentId: "chat-abc-1-dead" }],
	});
	expect(counters.promptsByDay).toEqual({ "2026-07-16": 2 });
	expect(counters.pushTapsByDay).toEqual({ "2026-07-16": 2 });
});

test("a rotated .1 tail still counts (JsonlLog rotation must not amputate history)", async () => {
	const dir = scratchStateDir();
	writeFileSync(path.join(dir, "push-taps.jsonl.1"), jsonl([{ ts: D1_LATE, agentId: "chat-a" }]));
	writeFileSync(path.join(dir, "push-taps.jsonl"), jsonl([{ ts: D2_NOON, agentId: "chat-a" }]));
	expect((await computeAdoptionCounters(dir)).pushTapsByDay).toEqual({ "2026-07-15": 1, "2026-07-16": 1 });
});

test("torn tail lines and foreign shapes are dropped, the rest still counts", async () => {
	const dir = scratchStateDir();
	writeFileSync(path.join(dir, "push-taps.jsonl"), `${JSON.stringify({ ts: D2_NOON, agentId: "chat-a" })}\n{"ts": 17` /* crash mid-append */);
	writeFileSync(path.join(dir, "transitions.jsonl"), `${JSON.stringify(transition())}\nnot json\n${JSON.stringify({ hello: "world" })}\n`);
	const counters = await computeAdoptionCounters(dir);
	expect(counters.pushTapsByDay).toEqual({ "2026-07-16": 1 });
	expect(counters.promptsByDay).toEqual({ "2026-07-16": 1 });
});
