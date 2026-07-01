/**
 * omp-graph — deterministic tests for the normalized schema + adapter transforms.
 *
 * Every adapter splits a PURE transform (records → tracks) from its IO, so we pin
 * the shaping logic here with fixtures — no git spawn, no filesystem, no clock.
 */

import { expect, test } from "bun:test";
import { bucketSums, HOUR_MS, DAY_MS, inRange, lastDays, windowRange, type TimeRange } from "../src/omp-graph/schema.ts";
import { composeGraph } from "../src/omp-graph/compose.ts";
import { adapterConfig, type SourceAdapter } from "../src/omp-graph/adapter.ts";
import { classifyCommit, parseGitLog, commitTracks } from "../src/omp-graph/adapters/git-adapter.ts";
import { receiptTracks, coalesceActive } from "../src/omp-graph/adapters/receipts-adapter.ts";
import { automationTracks, summarizeAutomation } from "../src/omp-graph/adapters/automation-adapter.ts";
import { planeTracks } from "../src/omp-graph/adapters/plane-adapter.ts";
import { derive } from "../src/omp-graph/derive.ts";
import type { GraphDoc } from "../src/omp-graph/schema.ts";
import { parseGcalTsv, busyBands, calendarTracks, type CalendarEvent } from "../src/omp-graph/adapters/google-calendar-adapter.ts";
import { toTouch, parseTouches, crmTracks } from "../src/omp-graph/adapters/crm-adapter.ts";
import type { RunReceipt, AutomationEvent } from "../src/types.ts";
import type { PlaneIssueTemporal } from "../src/plane.ts";

const T0 = Date.parse("2026-06-24T00:00:00Z");
const RANGE: TimeRange = { start: T0, end: T0 + 7 * DAY_MS };
const hour = (h: number): number => T0 + h * HOUR_MS;

// ───────────────────────────── schema ─────────────────────────────

test("bucketSums sums into hourly bins and drops out-of-range", () => {
	const bins = bucketSums(RANGE, HOUR_MS, [
		{ t: hour(1), v: 2 },
		{ t: hour(1) + 60_000, v: 3 }, // same hour bin
		{ t: hour(2), v: 5 },
		{ t: T0 - 1, v: 99 }, // before range → dropped
	]);
	expect(bins.length).toBe(7 * 24);
	expect(bins[1].v).toBe(5); // hour 1 bin: 2 + 3
	expect(bins[2].v).toBe(5);
	expect(bins.reduce((a, b) => a + b.v, 0)).toBe(10); // 99 excluded
});

test("inRange is half-open and lastDays anchors to now", () => {
	expect(inRange(RANGE.start, RANGE)).toBe(true);
	expect(inRange(RANGE.end, RANGE)).toBe(false);
	const r = lastDays(3, 1000 + 3 * DAY_MS);
	expect(r.end - r.start).toBe(3 * DAY_MS);
});

test("windowRange reaches into the future and past around now", () => {
	const now = 10 * DAY_MS;
	const r = windowRange(7, 3, now);
	expect(r.start).toBe(now - 7 * DAY_MS);
	expect(r.end).toBe(now + 3 * DAY_MS);
	// futureDays 0 collapses to a past-only window ending at now
	expect(windowRange(7, 0, now).end).toBe(now);
});

test("adapterConfig reads a per-adapter secret from context", () => {
	expect(adapterConfig({ config: { stripe: { KEY: "sk_test" } } }, "stripe", "KEY")).toBe("sk_test");
	expect(adapterConfig({}, "stripe", "KEY")).toBeUndefined();
});

// ───────────────────────────── git adapter ─────────────────────────────

const GIT_RAW = [
	"@@C@@\t2026-06-25T14:22:40Z\tAlice\tsquad(x): land x",
	"10\t2\tsrc/a.ts",
	"5\t0\tsrc/b.ts",
	"@@C@@\t2026-06-25T15:00:00Z\tBob\tchore: tidy",
	"1\t1\tsrc/c.ts",
	"@@C@@\t2026-06-26T09:00:00Z\tCarol\tfeat: big feature",
	"300\t20\tsrc/d.ts",
	"-\t-\tassets/bin.png", // binary → counts as a file, 0 churn
].join("\n");

test("classifyCommit maps conventional subjects", () => {
	expect(classifyCommit("squad(x): land x")).toBe("land");
	expect(classifyCommit("feat: y")).toBe("feat");
	expect(classifyCommit("fix: z")).toBe("fix");
	expect(classifyCommit("docs: d")).toBe("docs");
	expect(classifyCommit("random change")).toBe("other");
});

test("parseGitLog parses commits, numstat, and binary rows", () => {
	const commits = parseGitLog(GIT_RAW);
	expect(commits.length).toBe(3);
	expect(commits[0]).toMatchObject({ author: "Alice", insertions: 15, deletions: 2, files: 2 });
	expect(commits[2]).toMatchObject({ author: "Carol", insertions: 300, deletions: 20, files: 2 }); // incl. binary file
});

test("commitTracks emits events + two bar tracks; only notable commits become marks", () => {
	const tracks = commitTracks(parseGitLog(GIT_RAW), RANGE, "fleet", "git");
	expect(tracks.map((t) => t.id)).toEqual(["git.milestones", "git.commits", "git.churn"]);

	const ev = tracks.find((t) => t.id === "git.milestones");
	expect(ev?.type).toBe("events");
	if (ev?.type === "events") {
		// land + feat are notable; the trivial "chore" (churn 2) is not.
		expect(ev.marks.map((m) => m.kind).sort()).toEqual(["feat", "land"]);
		expect(ev.marks.map((m) => m.t)).toEqual([...ev.marks.map((m) => m.t)].sort((a, b) => a - b)); // time-ordered
	}

	const commits = tracks.find((t) => t.id === "git.commits");
	if (commits?.type === "bars") expect(commits.bins.reduce((a, b) => a + b.v, 0)).toBe(3);

	const churn = tracks.find((t) => t.id === "git.churn");
	if (churn?.type === "bars") {
		expect(churn.scale).toBe("sqrt");
		expect(churn.bins.reduce((a, b) => a + b.v, 0)).toBe(17 + 2 + 320);
	}
});

// ───────────────────────────── receipts adapter ─────────────────────────────

const rc = (over: Partial<RunReceipt>): RunReceipt => ({
	agentId: "a",
	name: "agent",
	repo: "/r",
	runId: "run",
	startedAt: hour(1),
	status: "working",
	toolCalls: 0,
	toolTally: {},
	filesTouched: [],
	...over,
});

test("coalesceActive merges contiguous active hours into segments", () => {
	const segs = coalesceActive([false, true, true, false, true], RANGE, HOUR_MS);
	expect(segs.length).toBe(2);
	expect(segs[0]).toMatchObject({ t0: hour(1), t1: hour(3), category: "active" });
	expect(segs[1]).toMatchObject({ t0: hour(4), t1: hour(5) });
});

test("receiptTracks emits cost series, session spans, and a fleet-state band", () => {
	const receipts = [
		rc({ name: "r1", startedAt: hour(1), endedAt: hour(2), costUsd: 1.5, status: "working" }),
		rc({ name: "r2", startedAt: hour(2), endedAt: hour(3), costUsd: 2, status: "stopped" }),
	];
	const tracks = receiptTracks(receipts, RANGE, "fleet", "receipts");
	expect(tracks.map((t) => t.id)).toEqual(["receipts.cost", "receipts.sessions", "receipts.state"]);

	const cost = tracks.find((t) => t.id === "receipts.cost");
	if (cost?.type === "series") expect(cost.points.reduce((a, p) => a + p.v, 0)).toBeCloseTo(3.5, 5);

	const sessions = tracks.find((t) => t.id === "receipts.sessions");
	if (sessions?.type === "spans") {
		expect(sessions.spans.length).toBe(2);
		expect(sessions.spans[0].t0).toBeLessThanOrEqual(sessions.spans[1].t0); // time-ordered
		expect(sessions.spans[0].meta?.files).toBe(0);
	}

	const state = tracks.find((t) => t.id === "receipts.state");
	// hours 1,2,3 all active → one coalesced band
	if (state?.type === "bands") expect(state.segments.length).toBe(1);
});

// ───────────────────────────── automation adapter ─────────────────────────────

const ae = (over: Partial<AutomationEvent>): AutomationEvent => ({ id: 1, at: hour(2), loop: "scout", ...over });

test("summarizeAutomation prefers the strongest signal", () => {
	expect(summarizeAutomation(ae({ filed: 2 }))).toBe("scout · filed 2");
	expect(summarizeAutomation(ae({ loop: "dispatch", spawned: 3 }))).toBe("dispatch · spawned 3");
	expect(summarizeAutomation(ae({ found: 4 }))).toBe("scout · found 4");
	expect(summarizeAutomation(ae({}))).toBe("scout");
});

test("automationTracks marks only meaningful ticks and bins llm calls", () => {
	const events = [
		ae({ id: 1, at: hour(2), loop: "scout", llmCalls: 1 }),
		ae({ id: 2, at: hour(3), loop: "dispatch", spawned: 2 }),
		ae({ id: 3, at: hour(4), loop: "observer" }), // bare → not meaningful
	];
	const tracks = automationTracks(events, RANGE, "automation", "automation");
	const marks = tracks.find((t) => t.id === "automation.loops");
	if (marks?.type === "events") expect(marks.marks.length).toBe(2); // observer excluded

	const llm = tracks.find((t) => t.id === "automation.llm");
	if (llm?.type === "bars") expect(llm.bins.reduce((a, b) => a + b.v, 0)).toBe(1);
});

// ───────────────────────────── plane adapter ─────────────────────────────

const pi = (over: Partial<PlaneIssueTemporal>): PlaneIssueTemporal => ({ id: 'i', name: 'issue', ...over });

test("planeTracks emits closed events, closed/day bars, and issue-lifetime spans", () => {
	const issues = [
		pi({ id: 'i1', identifier: 'OMPSQ-1', name: 'land x', state: 'completed', createdAt: hour(1), completedAt: hour(5) }),
		pi({ id: 'i2', identifier: 'OMPSQ-2', name: 'wip y', state: 'started', createdAt: hour(2) }), // open → span to range.end
		pi({ id: 'i3', name: 'old', state: 'completed', createdAt: T0 - 5 * DAY_MS, completedAt: T0 - DAY_MS }), // closed before window
	];
	const tracks = planeTracks(issues, RANGE, 'delivery', 'plane');
	expect(tracks.map((t) => t.id)).toEqual(['plane.closed', 'plane.closedPerDay', 'plane.issues']);

	const closed = tracks.find((t) => t.id === 'plane.closed');
	if (closed?.type === 'events') {
		expect(closed.marks.length).toBe(1); // only i1 completed in-window
		expect(closed.marks[0].label).toContain('OMPSQ-1');
		expect(closed.marks[0].kind).toBe('done');
	}

	const perDay = tracks.find((t) => t.id === 'plane.closedPerDay');
	if (perDay?.type === 'bars') {
		expect(perDay.binMs).toBe(DAY_MS);
		expect(perDay.bins.reduce((a, b) => a + b.v, 0)).toBe(1);
	}

	const wip = tracks.find((t) => t.id === 'plane.issues');
	if (wip?.type === 'spans') {
		// i1 (closed) + i2 (open, extends to range.end); i3 ended before the window
		expect(wip.spans.length).toBe(2);
		const open = wip.spans.find((s) => s.label === 'OMPSQ-2');
		expect(open?.t1).toBe(RANGE.end);
		expect(open?.status).toBe('started');
	}
});

// ───────────────────────────── google calendar adapter ─────────────────────────────

test("parseGcalTsv parses timed + all-day rows and skips malformed", () => {
	const tsv = ["2026-06-25\t14:00\t2026-06-25\t15:00\tDesign review", "2026-06-26\t\t2026-06-27\t\tOffsite", "garbage"].join("\n");
	const events = parseGcalTsv(tsv);
	expect(events.length).toBe(2);
	expect(events[0]).toMatchObject({ title: "Design review", allDay: false });
	expect(events[0].end).toBeGreaterThan(events[0].start);
	expect(events[1].allDay).toBe(true);
});

test("busyBands merges overlapping meetings into contiguous busy stretches", () => {
	const evs: CalendarEvent[] = [
		{ title: "a", start: hour(9), end: hour(10) },
		{ title: "b", start: hour(10), end: hour(11) }, // touches a → merge
		{ title: "c", start: hour(13), end: hour(14) }, // gap → separate
	];
	const bands = busyBands(evs, RANGE);
	expect(bands.length).toBe(2);
	expect(bands[0]).toMatchObject({ t0: hour(9), t1: hour(11), category: "busy" });
});

test("calendarTracks emits meeting spans, meetings/day bars, and busy bands", () => {
	const evs: CalendarEvent[] = [
		{ title: "standup", start: hour(9), end: hour(9) + 30 * 60_000, status: "confirmed" },
		{ title: "1:1", start: hour(14), end: hour(15), status: "tentative" },
		{ title: "all-day conf", start: hour(0), end: hour(0) + 86_400_000, allDay: true },
	];
	const tracks = calendarTracks(evs, RANGE, "meetings", "google");
	expect(tracks.map((t) => t.id)).toEqual(["gcal.meetings", "gcal.perDay", "gcal.busy"]);

	const spans = tracks.find((t) => t.id === "gcal.meetings");
	if (spans?.type === "spans") {
		expect(spans.spans.length).toBe(2); // all-day excluded from spans
		expect(spans.spans.find((s) => s.label === "1:1")?.status).toBe("tentative");
	}
	const perDay = tracks.find((t) => t.id === "gcal.perDay");
	if (perDay?.type === "bars") expect(perDay.bins.reduce((a, b) => a + b.v, 0)).toBe(2); // timed meetings only
});

// ───────────────────────────── crm adapter ─────────────────────────────

test("toTouch maps DerivedInteraction, Interaction, and native shapes tolerantly", () => {
	// DerivedInteraction (local-extractor push): peerUsername + ISO at + inbound/outbound
	const d = toTouch({ peerUsername: "alice", peerExternalId: "123", channel: "telegram", at: "2026-06-25T10:00:00Z", direction: "inbound", summary: "8 in / 4 out over 30d" });
	expect(d).toMatchObject({ contact: "alice", direction: "in", channel: "telegram" });
	expect(d?.at).toBe(Date.parse("2026-06-25T10:00:00Z"));
	// Interaction (SoR): contactId + outbound
	expect(toTouch({ contactId: "c_7", channel: "telegram", at: "2026-06-25T11:00:00Z", direction: "outbound", summary: "sent deck" })).toMatchObject({ contact: "c_7", direction: "out" });
	// no timestamp → null
	expect(toTouch({ contact: "x" })).toBeNull();
});

test("parseTouches handles both a JSON array and JSONL", () => {
	const arr = JSON.stringify([{ contact: "a", at: hour(1) }, { contact: "b", at: hour(2) }]);
	expect(parseTouches(arr).length).toBe(2);
	const jsonl = [`{"contact":"a","at":${hour(1)}}`, "torn{", `{"contact":"b","at":${hour(2)}}`].join("\n");
	expect(parseTouches(jsonl).length).toBe(2); // torn line tolerated
});

test("crmTracks emits touches/day bars, touch events, and per-contact conversation spans", () => {
	const touches = [
		{ contact: "alice", at: hour(9), direction: "in" as const },
		{ contact: "alice", at: hour(11), direction: "out" as const },
		{ contact: "bob", at: hour(14), direction: "out" as const },
	];
	const tracks = crmTracks(touches, RANGE, "crm", "crm");
	expect(tracks.map((t) => t.id)).toEqual(["crm.touches", "crm.events", "crm.contacts"]);

	const bars = tracks.find((t) => t.id === "crm.touches");
	if (bars?.type === "bars") expect(bars.bins.reduce((a, b) => a + b.v, 0)).toBe(3);

	const spans = tracks.find((t) => t.id === "crm.contacts");
	if (spans?.type === "spans") {
		expect(spans.spans.length).toBe(2); // alice + bob
		const alice = spans.spans.find((s) => s.label === "alice");
		expect(alice?.t0).toBe(hour(9));
		expect(alice?.t1).toBe(hour(11)); // first→last touch
		expect(alice?.status).toBe("mixed"); // 1 in + 1 out
	}
});

// ───────────────────────────── derive (insights) ─────────────────────────────

test("derive computes efficiency tracks + insight callouts", () => {
	const now = T0 + 7 * DAY_MS;
	const range: TimeRange = { start: T0, end: now };
	const doc: GraphDoc = {
		range,
		groups: [],
		sources: [],
		generatedAt: now,
		tracks: [
			{ id: 'git.commits', label: 'C', group: 'fleet', source: 'git', type: 'bars', binMs: HOUR_MS, bins: [{ t: hour(1), v: 2 }, { t: hour(2), v: 2 }] }, // 4 commits
			{ id: 'plane.closed', label: 'X', group: 'delivery', source: 'plane', type: 'events', marks: [{ t: hour(5), label: 'OMPSQ-1', kind: 'done' }, { t: hour(6), label: 'OMPSQ-2', kind: 'done' }] }, // 2 tickets
		],
	};
	const receipts = [
		rc({ startedAt: hour(1), endedAt: hour(2), costUsd: 8, filesTouched: ['a'], tokens: { input: 100, output: 0, cacheRead: 300, cacheWrite: 0, total: 400 } }),
		rc({ startedAt: hour(3), endedAt: hour(4), costUsd: 2, filesTouched: [], tokens: { input: 50, output: 0, cacheRead: 50, cacheWrite: 0, total: 100 } }), // idle: 0 files
	];
	const { tracks, insights } = derive(doc, receipts, range, now);

	expect(insights.find((i) => i.id === 'cpt')?.value).toBe('$5'); // $10 / 2 tickets
	expect(insights.find((i) => i.id === 'idle')?.value).toBe('20%'); // $2 idle / $10
	expect(insights.find((i) => i.id === 'cache')?.value).toBe('70%'); // 350 / 500
	expect(insights.find((i) => i.id === 'cpc')?.value).toBe('$2.5'); // $10 / 4 commits
	expect(tracks.find((t) => t.id === 'derived.costPerCommit')?.type).toBe('series');
	expect(tracks.find((t) => t.id === 'derived.idleBurn')?.type).toBe('bars');
});

// ───────────────────────────── compose ─────────────────────────────

test("composeGraph merges tracks, degrades a throwing adapter, and hides empty groups", async () => {
	const good: SourceAdapter = {
		id: "good",
		label: "Good",
		group: { id: "g", label: "Good", order: 0 },
		async tracks() {
			return [{ id: "g.x", label: "X", group: "g", source: "good", type: "bars", binMs: HOUR_MS, bins: [] }];
		},
	};
	const bad: SourceAdapter = {
		id: "bad",
		label: "Bad",
		group: { id: "b", label: "Bad", order: 1 },
		async tracks() {
			throw new Error("boom");
		},
	};
	const doc = await composeGraph(RANGE, {}, [good, bad], { now: 123 });
	expect(doc.tracks.length).toBe(1);
	expect(doc.sources).toEqual(["good", "bad"]); // both recorded even though bad produced nothing
	expect(doc.groups.map((g) => g.id)).toEqual(["g"]); // bad's group hidden (no tracks)
	expect(doc.generatedAt).toBe(123);
});
