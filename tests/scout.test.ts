/**
 * Scout — reasoning harvester (sibling to the Observer). Every edge runs through fake deps, no daemon.
 *
 * Covers the contract: (a) inert when OMP_SQUAD_SCOUT=0 or the reasoning is trivial (no LLM call);
 * (b) extracted tickets are filed (with a [scout] do-not-auto-land title + provenance body); (c) the
 * per-run cap bounds one scan; (d) the global open-issue cap; (e) dedup against the persisted seen-set
 * (across a fresh Scout over the same stateDir); (f) dedup against existing OPEN issues by fuzzy title;
 * plus the mid-run path: (g) unscannedReasoning cursor/trickle logic, (h) tick() over liveReasoning,
 * (i) scan() serialization (two concurrent scans can't race-file the same item). Plus pure helpers.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AutomationReport } from "../src/automation-log.ts";
import { DEFAULT_SCOUT_MAX_CALLS_PER_HOUR, MIN_SCAN_CHARS, Scout, ScoutCallBudget, type ScoutDeps, jaccard, parseTickets, scoutMaxCallsPerHour, titleTokens, unscannedReasoning } from "../src/scout.ts";
import type { IssueRef, TranscriptEntry } from "../src/types.ts";

const ENV_KEYS = ["OMP_SQUAD_SCOUT", "OMP_SQUAD_SCOUT_MAX", "OMP_SQUAD_SCOUT_PER_RUN", "OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const tmpDir = (): string => mkdtempSync(path.join(os.tmpdir(), "scout-"));
// Reasoning longer than MIN_SCAN_CHARS, so scan() doesn't short-circuit.
const BIG = `While implementing the RPC seam I noticed the reconnect path drops buffered events. ${"context ".repeat(40)}`;

const json = (tickets: { title: string; detail?: string; kind?: string }[]): string => JSON.stringify({ tickets });
const entry = (kind: TranscriptEntry["kind"], text: string, ts: number): TranscriptEntry => ({ kind, text, ts });

interface Filed {
	title: string;
	body: string;
}
interface Harness {
	deps: ScoutDeps;
	filed: Filed[];
	calls: { extract: number };
}
function makeDeps(stateDir: string, over: Partial<ScoutDeps> & { tickets?: string } = {}): Harness {
	const filed: Filed[] = [];
	const calls = { extract: 0 };
	let seq = 0;
	const { tickets, ...overDeps } = over;
	const deps: ScoutDeps = {
		extract: async () => {
			calls.extract++;
			return tickets ?? json([]);
		},
		listIssues: async () => [],
		fileIssue: async (title, body) => {
			filed.push({ title, body });
			return { id: `i-${++seq}`, name: title, identifier: `OMPSQ-${seq}` } satisfies IssueRef;
		},
		stateDir,
		now: () => 1,
		log: () => {},
		...overDeps,
	};
	return { deps, filed, calls };
}

// ── pure helpers ───────────────────────────────────────────────────────────

test("parseTickets reads {tickets:[...]}, drops titleless items, coerces unknown/proto kind, tolerates fences", () => {
	// "toString" is a proto-chain key — must NOT count as a valid kind (own-value check, not `in`).
	const raw = "```json\n" + json([{ title: "Fix leak", detail: "memory grows", kind: "bug" }, { title: "", detail: "x" }, { title: "Refactor", kind: "weird" }, { title: "Proto guard", kind: "toString" }]) + "\n```";
	const got = parseTickets(raw);
	expect(got).toEqual([
		{ title: "Fix leak", detail: "memory grows", kind: "bug" },
		{ title: "Refactor", detail: "", kind: "followup" }, // empty title dropped; unknown kind → followup
		{ title: "Proto guard", detail: "", kind: "followup" }, // proto-chain key rejected → followup
	]);
});

test("parseTickets returns [] on junk / empty", () => {
	expect(parseTickets("no json here")).toEqual([]);
	expect(parseTickets(json([]))).toEqual([]);
});

test("jaccard/titleTokens strip tags+markers and measure overlap", () => {
	const a = titleTokens("[scout] do-not-auto-land: Add retry to RPC client");
	const b = titleTokens("Add retry logic to the RPC client");
	expect(a.has("scout")).toBe(false); // tag stripped
	expect(a.has("retry")).toBe(true);
	expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.6);
	expect(jaccard(a, titleTokens("Rewrite the auth module"))).toBeLessThan(0.6);
	expect(jaccard(new Set(), a)).toBe(0); // empty side ⇒ 0
});

// ── unscannedReasoning (mid-run cursor) ──────────────────────────────────────

test("(g) unscannedReasoning returns assistant+thinking past the cursor and advances it to the last ts", () => {
	const big = "x".repeat(MIN_SCAN_CHARS + 10);
	const tx = [entry("user", "the task", 5), entry("assistant", big, 10), entry("thinking", "y".repeat(20), 20)];
	const { text, cursor } = unscannedReasoning(tx, 0);
	expect(text).toContain(big);
	expect(text).not.toContain("the task"); // user excluded
	expect(cursor).toBe(20); // advanced to the last included entry
});

test("(g) unscannedReasoning leaves the cursor put until MIN_SCAN_CHARS accrues (no trickle skip)", () => {
	const tx = [entry("assistant", "short", 10)];
	expect(unscannedReasoning(tx, 0)).toEqual({ text: "", cursor: 0 });
	// ts filter: nothing past the cursor ⇒ empty, cursor unchanged.
	const tx2 = [entry("assistant", "x".repeat(MIN_SCAN_CHARS + 1), 10)];
	expect(unscannedReasoning(tx2, 10)).toEqual({ text: "", cursor: 10 });
});

test("(g) unscannedReasoning ignores non-reasoning kinds (tool/user/system)", () => {
	const tx = [entry("tool", "z".repeat(MIN_SCAN_CHARS + 50), 10), entry("system", "s".repeat(50), 11)];
	expect(unscannedReasoning(tx, 0)).toEqual({ text: "", cursor: 0 });
});

// ── scan() behavior ─────────────────────────────────────────────────────────

test("(a) inert when OMP_SQUAD_SCOUT=0 — no LLM call, no file", async () => {
	process.env.OMP_SQUAD_SCOUT = "0";
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "Fix it" }]) });
	await new Scout(h.deps).scan(BIG, { agent: "ag1" });
	expect(h.calls.extract).toBe(0);
	expect(h.filed).toEqual([]);
});

test("(a) inert on trivial reasoning (< MIN_SCAN_CHARS) — no LLM call", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "Fix it" }]) });
	await new Scout(h.deps).scan("too short", { agent: "ag1" });
	expect(h.calls.extract).toBe(0);
	expect(h.filed).toEqual([]);
});

test("(record) one automation event per scan — carries llmCalls=1, found, filed, agent (the cost signal)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const events: AutomationReport[] = [];
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "A brand new delta item" }]), record: (r) => events.push(r) });
	await new Scout(h.deps).scan(BIG, { agent: "ag1" });
	expect(events.length).toBe(1);
	expect(events[0].llmCalls).toBe(1);
	expect(events[0].found).toBe(1);
	expect(events[0].filed).toBe(1);
	expect(events[0].agent).toBe("ag1");
});

test("(record) a trivial scan costs no LLM call and emits no event (no phantom cost)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const events: AutomationReport[] = [];
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "x" }]), record: (r) => events.push(r) });
	await new Scout(h.deps).scan("too short", { agent: "ag1" });
	expect(h.calls.extract).toBe(0);
	expect(events.length).toBe(0);
});

test("(record) an LLM/transport error still emits an event marked error with llmCalls=1 (failed calls cost too)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const events: AutomationReport[] = [];
	const h = makeDeps(tmpDir(), {
		record: (r) => events.push(r),
		extract: async () => {
			throw new Error("model unreachable");
		},
	});
	await new Scout(h.deps).scan(BIG, { agent: "ag1" });
	expect(events.length).toBe(1);
	expect(events[0].llmCalls).toBe(1);
	expect(events[0].level).toBe("error");
});

test("(b) extracted items are filed with a [scout] do-not-auto-land title + provenance body", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "Buffer events across reconnect", detail: "events drop on RPC reconnect", kind: "bug" }]) });
	await new Scout(h.deps).scan(BIG, { agent: "rpc-agent", issue: "OMPSQ-54" });
	expect(h.filed.length).toBe(1);
	expect(h.filed[0].title).toBe("[scout] do-not-auto-land: Buffer events across reconnect");
	expect(h.filed[0].body).toContain("rpc-agent");
	expect(h.filed[0].body).toContain("OMPSQ-54");
	expect(h.filed[0].body).toContain("events drop on RPC reconnect");
});

test("(c) per-run cap bounds one scan (OMP_SQUAD_SCOUT_PER_RUN)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	process.env.OMP_SQUAD_SCOUT_PER_RUN = "2";
	const five = json(["Persist rate-limit ledger", "Add webhook idempotency key", "Cache reconnect buffer", "Validate project mapping", "Throttle observer ticks"].map((title) => ({ title })));
	const h = makeDeps(tmpDir(), { tickets: five });
	await new Scout(h.deps).scan(BIG, { agent: "ag1" });
	expect(h.filed.length).toBe(2);
});

test("(d) global open-issue cap stops filing (OMP_SQUAD_SCOUT_MAX)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	process.env.OMP_SQUAD_SCOUT_MAX = "2";
	const open: IssueRef[] = [
		{ id: "a", name: "[scout] do-not-auto-land: one alpha thing" },
		{ id: "b", name: "[scout] do-not-auto-land: two bravo thing" },
	];
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "A brand new charlie item" }]), listIssues: async () => open });
	await new Scout(h.deps).scan(BIG, { agent: "ag1" });
	expect(h.filed).toEqual([]); // already at cap (2 open [scout] issues)
});

test("(e) seen-set dedup: same item never re-filed, persisted across a fresh Scout over the same stateDir", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const dir = tmpDir();
	const payload = json([{ title: "Add idempotency key to webhook handler" }]);
	const h1 = makeDeps(dir, { tickets: payload });
	await new Scout(h1.deps).scan(BIG, { agent: "ag1" });
	expect(h1.filed.length).toBe(1);

	// Same item again → seen ⇒ 0 new. (listIssues still empty: proves the seen-set, not open-dedup.)
	await new Scout(h1.deps).scan(BIG, { agent: "ag1" });
	expect(h1.filed.length).toBe(1);

	// A fresh Scout over the same stateDir loads scout-seen.json ⇒ still deduped.
	const h2 = makeDeps(dir, { tickets: payload });
	await new Scout(h2.deps).scan(BIG, { agent: "ag2" });
	expect(h2.filed).toEqual([]);
});

test("(OMPSQ-137) distinct seenFile ⇒ independent dedup: a 2nd repo's scout re-files the same item", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const dir = tmpDir(); // one shared stateDir, as the manager uses for every per-repo scout
	const payload = json([{ title: "Add idempotency key to webhook handler" }]);

	// Repo A's scout keeps the legacy filename (seenFile undefined) and files the item.
	const a = makeDeps(dir, { tickets: payload });
	await new Scout(a.deps).scan(BIG, { agent: "agA" });
	expect(a.filed.length).toBe(1);

	// Repo B's scout has a distinct seenFile ⇒ does NOT inherit A's seen-map, so the same latent item
	// is filed into B's tracker too. A shared map (the bug) would suppress this and leave B uncovered.
	const b = makeDeps(dir, { tickets: payload, seenFile: "scout-seen.repo-b.json" });
	await new Scout(b.deps).scan(BIG, { agent: "agB" });
	expect(b.filed.length).toBe(1);
});

test("(f) fuzzy dedup against an existing OPEN issue (human/observer work) — not re-filed", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const open: IssueRef[] = [{ id: "h1", name: "Add retry to RPC client" }]; // plain human issue, no [scout] tag
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "Add retry logic to the RPC client" }]), listIssues: async () => open });
	await new Scout(h.deps).scan(BIG, { agent: "ag1" });
	expect(h.filed).toEqual([]);
});

test("a file failure is not persisted — a later run re-harvests it", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const dir = tmpDir();
	const payload = json([{ title: "Persist the rate-limit ledger to disk" }]);
	const failing = makeDeps(dir, { tickets: payload, fileIssue: async () => null }); // Plane down
	await new Scout(failing.deps).scan(BIG, { agent: "ag1" });
	expect(failing.filed).toEqual([]);

	// Plane recovers: a fresh Scout over the same stateDir files it (the failed attempt left no fingerprint).
	const ok = makeDeps(dir, { tickets: payload });
	await new Scout(ok.deps).scan(BIG, { agent: "ag1" });
	expect(ok.filed.length).toBe(1);
});

// ── mid-run sweep (tick + liveReasoning) ─────────────────────────────────────

test("(h) tick() scans each live agent's reasoning via liveReasoning", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const h = makeDeps(tmpDir(), {
		tickets: json([{ title: "Extract the duplicated retry helper" }]),
		liveReasoning: () => [{ agent: "ag1", text: BIG }],
	});
	await new Scout(h.deps).tick();
	expect(h.filed.length).toBe(1);
	expect(h.filed[0].title).toContain("Extract the duplicated retry helper");
});

test("(h) tick() is inert when disabled or when liveReasoning yields nothing", async () => {
	process.env.OMP_SQUAD_SCOUT = "0";
	const off = makeDeps(tmpDir(), { tickets: json([{ title: "x" }]), liveReasoning: () => [{ agent: "ag1", text: BIG }] });
	await new Scout(off.deps).tick();
	expect(off.calls.extract).toBe(0);

	process.env.OMP_SQUAD_SCOUT = "1";
	const empty = makeDeps(tmpDir(), { tickets: json([{ title: "x" }]), liveReasoning: () => [] });
	await new Scout(empty.deps).tick();
	expect(empty.calls.extract).toBe(0);
});

test("(i) concurrent scans of the same item file it once (serialized seen-safety)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	const h = makeDeps(tmpDir(), { tickets: json([{ title: "Wire backpressure into the SSE bridge" }]) });
	const s = new Scout(h.deps);
	await Promise.all([s.scan(BIG, { agent: "ag1" }), s.scan(BIG, { agent: "ag1" })]);
	expect(h.filed.length).toBe(1); // second scan, serialized, sees the seen-set
});

// ── #16: global per-hour LLM-call budget ─────────────────────────────────────

test("(#16) scoutMaxCallsPerHour: default + env override + invalid fallback", () => {
	delete process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR;
	expect(scoutMaxCallsPerHour()).toBe(DEFAULT_SCOUT_MAX_CALLS_PER_HOUR);
	process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR = "5";
	expect(scoutMaxCallsPerHour()).toBe(5);
	process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR = "nonsense";
	expect(scoutMaxCallsPerHour()).toBe(DEFAULT_SCOUT_MAX_CALLS_PER_HOUR);
	process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR = "0"; // 0 ⇒ unlimited (handled in the budget)
	expect(scoutMaxCallsPerHour()).toBe(0);
});

test("(#16) ScoutCallBudget admits up to N/hour, refuses past it, and the window slides", () => {
	let clock = 1_000_000;
	const b = new ScoutCallBudget(() => 2, () => clock);
	expect(b.tryConsume()).toBe(true); // 1
	expect(b.tryConsume()).toBe(true); // 2
	expect(b.tryConsume()).toBe(false); // 3 — over budget
	expect(b.used()).toBe(2);
	clock += 3_600_001; // slide past the first two stamps' hour
	expect(b.tryConsume()).toBe(true); // window cleared ⇒ admitted again
	expect(b.used()).toBe(1);
});

test("(#16) ScoutCallBudget: max<=0 ⇒ unlimited", () => {
	const b = new ScoutCallBudget(() => 0, () => 1);
	for (let i = 0; i < 100; i++) expect(b.tryConsume()).toBe(true);
});

test("(#16) once the per-hour budget is hit, further scans skip the LLM call (record a structured skip)", async () => {
	process.env.OMP_SQUAD_SCOUT = "1";
	process.env.OMP_SQUAD_SCOUT_MAX_CALLS_PER_HOUR = "2";
	const events: AutomationReport[] = [];
	let clock = 1_000_000;
	// Distinct titles per scan so dedup/seen-set never masks a skip; the budget is the only gate under test.
	let extractCalls = 0;
	const h = makeDeps(tmpDir(), {
		record: (r) => events.push(r),
		now: () => clock,
		extract: async () => {
			extractCalls++;
			return json([{ title: `Distinct latent item number ${extractCalls}` }]);
		},
	});
	const s = new Scout(h.deps);
	await s.scan(BIG, { agent: "ag1" }); // call 1 — admitted
	await s.scan(BIG, { agent: "ag1" }); // call 2 — admitted
	await s.scan(BIG, { agent: "ag1" }); // call 3 — OVER BUDGET ⇒ no LLM call
	expect(extractCalls).toBe(2); // only two extractions ever ran
	// Two cost events (llmCalls:1) + one structured skip event (llmCalls:0, info).
	const skips = events.filter((e) => e.llmCalls === 0 && e.skipReason === "budget");
	expect(skips.length).toBe(1);
	expect(skips[0].level).toBe("info");
	expect(skips[0].detail).toContain("budget reached");
	expect(events.filter((e) => e.llmCalls === 1).length).toBe(2);

	// Window slides ⇒ scanning resumes (a new distinct item is filed).
	clock += 3_600_001;
	await s.scan(BIG, { agent: "ag1" });
	expect(extractCalls).toBe(3);
});

test("start() arms no timer when OMP_SQUAD_SCOUT=0 or without a liveReasoning dep; arms one otherwise", () => {
	const real = globalThis.setInterval;
	let armed = 0;
	// @ts-expect-error — spy stand-in for the timer factory.
	globalThis.setInterval = () => {
		armed++;
		return { unref() {} } as unknown as Timer;
	};
	try {
		process.env.OMP_SQUAD_SCOUT = "0";
		new Scout(makeDeps(tmpDir(), { liveReasoning: () => [] }).deps).start();
		expect(armed).toBe(0); // disabled ⇒ no timer

		process.env.OMP_SQUAD_SCOUT = "1";
		new Scout(makeDeps(tmpDir()).deps).start(); // no liveReasoning dep
		expect(armed).toBe(0);

		new Scout(makeDeps(tmpDir(), { liveReasoning: () => [] }).deps).start();
		expect(armed).toBe(1);
	} finally {
		globalThis.setInterval = real;
	}
});
