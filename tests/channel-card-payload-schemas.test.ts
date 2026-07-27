/**
 * Concern 07 — per-kind card payload schemas, the href sink close, and the observational
 * validation wired at `ChannelStore#appendManager` (`../src/channels.ts`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChannelStore } from "../src/channels.ts";
import { FileStore } from "../src/dal/store.ts";
import {
	CARD_PAYLOAD_SCHEMAS,
	__resetCardPayloadValidationState,
	cardPayloadStrict,
	emitDesignRevisedCard,
	emitGoalOverlapCard,
	emitMentionSteerCard,
	emitReturnEmitCard,
	emitTokenBurnSnapshotCard,
	validateCardPayload,
} from "../src/schema/channel-card.ts";
import {
	TRANSCRIPT_EVENT_DESIGN_REVISED,
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_GOAL_OVERLAP,
	TRANSCRIPT_EVENT_LAND_ASSESSMENT,
	TRANSCRIPT_EVENT_LAND_ATTEMPT,
	TRANSCRIPT_EVENT_LAND_MERGE,
	TRANSCRIPT_EVENT_MENTION_STEER,
	TRANSCRIPT_EVENT_NEEDS_YOU,
	TRANSCRIPT_EVENT_PLAN_CARD,
	TRANSCRIPT_EVENT_PR_OPENED,
	TRANSCRIPT_EVENT_RETURN_EMIT,
	TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT,
	TRANSCRIPT_EVENT_UNIT_FAILED,
	TRANSCRIPT_EVENT_UNIT_SPAWNED,
	TRANSCRIPT_EVENT_UNIT_TURN_FINISHED,
	TRANSCRIPT_EVENT_VERIFICATION_RAN,
	type TranscriptEventKind,
} from "../src/transcript-event-kinds.ts";

beforeEach(() => __resetCardPayloadValidationState());

/** One realistic emit fixture per daemon kind, mirroring the real shape each kind's emit site
 *  (or the shared projection funnel) actually puts on the wire — see `src/squad-manager.ts`. */
const FIXTURES: Record<TranscriptEventKind, unknown> = {
	[TRANSCRIPT_EVENT_LAND_ATTEMPT]: {
		refs: { unitId: "room-16", landId: "attempt-1" },
		doorSurface: "land",
		face: { unitId: "room-16", unitName: "Room 16", eventKind: "land-attempt", title: "Land attempt started", stage: "started", branch: "room-16-landcards", repo: "/tmp/repo" },
	},
	[TRANSCRIPT_EVENT_LAND_ASSESSMENT]: {
		refs: { unitId: "room-16", landId: "attempt-1" },
		doorSurface: "land",
		face: { unitId: "room-16", unitName: "Room 16", eventKind: "land-assessment", title: "Land assessment rejected", stage: "rejected", risk: "high", recommendation: "Hold until rebased.", detail: "stale branch overlaps main" },
	},
	[TRANSCRIPT_EVENT_LAND_MERGE]: {
		refs: { unitId: "room-16" },
		doorSurface: "land-merge",
		face: { unitId: "room-16", unitName: "Room 16", eventKind: "land-merge", title: "Land merge finalized", branch: "room-16-landcards", outcome: "merged", prNumber: 91, prUrl: "https://github.example/pr/91", doneProofVerified: "green" },
	},
	[TRANSCRIPT_EVENT_GATE_VERDICT]: {
		refs: { unitId: "room-08" },
		doorSurface: "gate-verdict",
		face: { unitId: "room-08", eventKind: "gate-verdict", title: "gate verdict · pass", verdict: "pass", agreement: 0.9, confidence: 0.8, perCriterion: [{ criterion: "tests", pass: true }], validation: { verdict: "pass" } },
	},
	[TRANSCRIPT_EVENT_NEEDS_YOU]: {
		refs: { unitId: "ada" },
		doorSurface: "intervence",
		face: { unitId: "ada", unitName: "Ada", eventKind: "needs-you", pendingId: "p1", pendingStatus: "pending", title: "Needs you · Approve deploy", body: "Approve deploy", tone: "warning", pinned: { agent: "Ada", age: "4m" } },
	},
	[TRANSCRIPT_EVENT_PLAN_CARD]: {
		refs: { planId: "feat-1" },
		doorSurface: "plan",
		face: { title: "the room", body: "14 concerns ready", pinned: { concerns: 14 }, planName: "voice-room" },
	},
	[TRANSCRIPT_EVENT_RETURN_EMIT]: {
		refs: { unitId: "room-42" },
		doorSurface: "intervence",
		face: { unitId: "room-42", unitName: "Room 42", eventKind: "return-emit", title: "Control accepted", eyebrow: "Room echo", body: "operator steered room-42: do the thing", tone: "info", pinned: { actor: "operator", action: "steer", target: "Room 42" } },
		actor: "operator",
		action: "steer",
		target: "room-42",
		source: "mention",
	},
	[TRANSCRIPT_EVENT_DESIGN_REVISED]: {
		refs: { planId: "feat-9", planPath: "plans/x/06-card-registry.md", unitId: "room-42" },
		doorSurface: "plan",
		face: { unitId: "room-42", unitName: "Room 42", eventKind: "design-revised", title: "Design revised", eyebrow: "Plan saved", body: "Harden the registry: status → done", detail: "plans/x/06-card-registry.md", tone: "info", planName: "voice-room", pinned: { actor: "operator", concern: "06-card-registry.md", status: "done" } },
		actor: "operator",
		featureId: "feat-9",
		planPath: "plans/x/06-card-registry.md",
		planName: "voice-room",
		changed: "status → done",
	},
	[TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT]: {
		refs: { unitId: "room-19" },
		doorSurface: "unit",
		face: { title: "Token burn · Verifier", eyebrow: "Unit economics", body: "1234 tokens · $0.9876", tone: "info", pinned: { unit: "Verifier", tokens: 1234, cost: "$0.9876" } },
	},
	[TRANSCRIPT_EVENT_UNIT_SPAWNED]: { refs: { unitId: "room-27" }, doorSurface: "unit", face: { title: "Unit spawned · Room 27", tone: "info" } },
	[TRANSCRIPT_EVENT_UNIT_TURN_FINISHED]: { refs: { unitId: "room-27" }, doorSurface: "unit", face: { title: "Turn finished · Room 27", tone: "success" } },
	[TRANSCRIPT_EVENT_UNIT_FAILED]: { refs: { unitId: "room-27" }, doorSurface: "unit", face: { title: "Unit failed · Room 27", tone: "destructive" } },
	[TRANSCRIPT_EVENT_PR_OPENED]: { refs: { unitId: "room-27" }, doorSurface: "unit", face: { title: "PR opened · Room 27", tone: "success" } },
	[TRANSCRIPT_EVENT_VERIFICATION_RAN]: { refs: { unitId: "room-27" }, doorSurface: "unit", face: { title: "Verification passed · Room 27", tone: "success" } },
	[TRANSCRIPT_EVENT_MENTION_STEER]: {
		face: { title: "Mention steer accepted", body: "operator steered @bob: hi", tone: "info", pinned: { actor: "operator", target: "bob", clientTurnId: "t1" } },
		actor: "operator",
		target: "agent-1",
		clientTurnId: "t1",
	},
	[TRANSCRIPT_EVENT_GOAL_OVERLAP]: {
		refs: { unitName: "room-51" },
		doorSurface: "unit",
		face: { title: "Possibly duplicated work", owner: "room-12", strength: "structural", pinned: { owner: "room-12", basis: "structural" } },
	},
};

describe("per-kind card payload schemas", () => {
	for (const [kind, fixture] of Object.entries(FIXTURES)) {
		test(`${kind}: a realistic emit fixture decodes`, () => {
			const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[kind as TranscriptEventKind]);
			const result = decode(fixture);
			expect(Result.isSuccess(result)).toBe(true);
		});
	}

	test("token-burn-snapshot's OTHER real shape (the bespoke fleet rollup) also decodes", () => {
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT]);
		const result = decode({
			kind: "fleet-rollup",
			reason: "cost-gate",
			action: "warn",
			line: "80% of budget",
			totals: { runs: 4, units: 2, tokens: 100, costUsd: 1.2, toolCalls: 9 },
			byUnit: [],
			byLane: [],
			byModel: [],
			refs: { reason: "cost-gate" },
			doorSurface: "fleet-economics",
			face: { title: "Fleet token burn threshold", eyebrow: "Fleet economics", body: "100 tokens", tone: "warning", status: "warn" },
		});
		expect(Result.isSuccess(result)).toBe(true);
	});

	test("a malformed emit fails: missing required face.title", () => {
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_NEEDS_YOU]);
		const result = decode({ refs: { unitId: "ada" }, doorSurface: "intervence", face: { body: "no title" } });
		expect(Result.isFailure(result)).toBe(true);
	});

	test("doorSurface is closed to the known-surface enum", () => {
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_PLAN_CARD]);
		expect(Result.isSuccess(decode({ doorSurface: "plan", face: { title: "ok" } }))).toBe(true);
		expect(Result.isFailure(decode({ doorSurface: "evil-surface", face: { title: "ok" } }))).toBe(true);
	});
});

describe("href sink closed", () => {
	for (const kind of [TRANSCRIPT_EVENT_PLAN_CARD, TRANSCRIPT_EVENT_RETURN_EMIT] as const) {
		test(`${kind}: javascript:/https: hrefs are rejected schema-side, #/ routes pass`, () => {
			const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[kind]);
			expect(Result.isFailure(decode({ face: { title: "x", href: "javascript:alert(1)" } }))).toBe(true);
			expect(Result.isFailure(decode({ face: { title: "x", href: "https://evil.example" } }))).toBe(true);
			expect(Result.isFailure(decode({ href: "javascript:alert(1)", face: { title: "x" } }))).toBe(true);
			expect(Result.isSuccess(decode({ face: { title: "x", href: "#/intervene/x" } }))).toBe(true);
			expect(Result.isSuccess(decode({ href: "#/intervene/x", face: { title: "x" } }))).toBe(true);
		});
	}
});

describe("register", () => {
	test("checked/claim/unverified are accepted; a bogus value is rejected", () => {
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_NEEDS_YOU]);
		for (const register of ["checked", "claim", "unverified"]) {
			expect(Result.isSuccess(decode({ face: { title: "x", register } }))).toBe(true);
		}
		expect(Result.isFailure(decode({ face: { title: "x", register: "bogus" } }))).toBe(true);
	});
});

describe("emitCard constructors round-trip their schema", () => {
	test("emitDesignRevisedCard", () => {
		const event = emitDesignRevisedCard(FIXTURES[TRANSCRIPT_EVENT_DESIGN_REVISED] as never);
		expect(event.kind).toBe(TRANSCRIPT_EVENT_DESIGN_REVISED);
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_DESIGN_REVISED]);
		expect(Result.isSuccess(decode(event.payload))).toBe(true);
	});

	test("emitMentionSteerCard", () => {
		const event = emitMentionSteerCard(FIXTURES[TRANSCRIPT_EVENT_MENTION_STEER] as never);
		expect(event.kind).toBe(TRANSCRIPT_EVENT_MENTION_STEER);
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_MENTION_STEER]);
		expect(Result.isSuccess(decode(event.payload))).toBe(true);
	});

	test("emitReturnEmitCard", () => {
		const event = emitReturnEmitCard(FIXTURES[TRANSCRIPT_EVENT_RETURN_EMIT] as never);
		expect(event.kind).toBe(TRANSCRIPT_EVENT_RETURN_EMIT);
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_RETURN_EMIT]);
		expect(Result.isSuccess(decode(event.payload))).toBe(true);
	});

	test("emitGoalOverlapCard", () => {
		const event = emitGoalOverlapCard(FIXTURES[TRANSCRIPT_EVENT_GOAL_OVERLAP] as never);
		expect(event.kind).toBe(TRANSCRIPT_EVENT_GOAL_OVERLAP);
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_GOAL_OVERLAP]);
		expect(Result.isSuccess(decode(event.payload))).toBe(true);
	});

	test("emitTokenBurnSnapshotCard", () => {
		const payload = {
			kind: "fleet-rollup" as const,
			reason: "cost-gate" as const,
			action: "warn",
			line: "80% of budget",
			totals: { runs: 4, units: 2, tokens: 100, costUsd: 1.2, toolCalls: 9 },
			byUnit: [],
			byLane: [],
			byModel: [],
			refs: { reason: "cost-gate" },
			doorSurface: "fleet-economics" as const,
			face: { title: "Fleet token burn threshold", eyebrow: "Fleet economics", body: "100 tokens", tone: "warning" as const, pinned: { units: 2, tokens: 100, cost: "$1.20" } },
		};
		const event = emitTokenBurnSnapshotCard(payload);
		expect(event.kind).toBe(TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT);
		const decode = Schema.decodeUnknownResult(CARD_PAYLOAD_SCHEMAS[TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT]);
		expect(Result.isSuccess(decode(event.payload))).toBe(true);
	});
});

describe("validateCardPayload", () => {
	test("a valid known-kind payload is ok with no log line", () => {
		const outcome = validateCardPayload(TRANSCRIPT_EVENT_PLAN_CARD, FIXTURES[TRANSCRIPT_EVENT_PLAN_CARD]);
		expect(outcome).toEqual({ ok: true });
	});

	test("a malformed known-kind payload logs and reasons EVERY time, with an incrementing counter", () => {
		const bad = { face: { body: "no title" } };
		const first = validateCardPayload(TRANSCRIPT_EVENT_PLAN_CARD, bad);
		const second = validateCardPayload(TRANSCRIPT_EVENT_PLAN_CARD, bad);
		expect(first.ok).toBe(false);
		expect(second.ok).toBe(false);
		expect(first.logLine).toBeTruthy();
		expect(second.logLine).toBeTruthy();
		expect(first.logLine).toContain("(1 total)");
		expect(second.logLine).toContain("(2 total)");
	});

	test("an unregistered kind warns exactly once across repeated emits", () => {
		const first = validateCardPayload("voice-call", { face: { title: "x" } });
		const second = validateCardPayload("voice-call", { face: { title: "x" } });
		const third = validateCardPayload("voice-call", { face: { title: "y" } });
		expect(first.ok).toBe(false);
		expect(second.ok).toBe(false);
		expect(third.ok).toBe(false);
		expect(first.logLine).toBeTruthy();
		expect(second.logLine).toBeUndefined();
		expect(third.logLine).toBeUndefined();
		// A DIFFERENT unregistered kind still gets its own first warning.
		const otherFirst = validateCardPayload("voice-decision", { face: { title: "x" } });
		expect(otherFirst.logLine).toBeTruthy();
	});
});

describe("cardPayloadStrict", () => {
	const KEY = "OMP_SQUAD_CARD_SCHEMA_STRICT";
	afterEach(() => { delete process.env[KEY]; });

	test("defaults off", () => {
		delete process.env[KEY];
		expect(cardPayloadStrict()).toBe(false);
	});

	test("OMP_SQUAD_CARD_SCHEMA_STRICT=1 turns it on", () => {
		process.env[KEY] = "1";
		expect(cardPayloadStrict()).toBe(true);
	});
});

describe("appendManager chokepoint (channels.ts)", () => {
	let dir: string;
	beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-card-schema-")); });
	afterEach(() => { delete process.env.OMP_SQUAD_CARD_SCHEMA_STRICT; });

	function store(): ChannelStore {
		return new ChannelStore(dir, new FileStore(dir));
	}

	test("production mode: a malformed known-kind emit logs once, increments the counter, and the card lands byte-identical", async () => {
		const logs: string[] = [];
		const channels = new ChannelStore(dir, new FileStore(dir), (m) => logs.push(m));
		const payload = { refs: { planId: "feat-1" }, doorSurface: "plan", face: { body: "no title at all" } };
		const entry = await channels.appendManager("fleet", { authorActor: "manager", text: "plan card", event: { kind: TRANSCRIPT_EVENT_PLAN_CARD, payload } });
		expect(entry.event?.payload).toEqual(payload);
		expect(logs.some((line) => line.includes("card schema") && line.includes("plan-card"))).toBe(true);
	});

	test("test flag: a malformed known-kind emit throws and nothing is persisted", async () => {
		process.env.OMP_SQUAD_CARD_SCHEMA_STRICT = "1";
		const channels = store();
		const payload = { refs: {}, doorSurface: "plan", face: { body: "no title at all" } };
		await expect(channels.appendManager("fleet", { authorActor: "manager", text: "plan card", event: { kind: TRANSCRIPT_EVENT_PLAN_CARD, payload } })).rejects.toThrow();
		const actor = { id: "web:operator", displayName: "Operator", origin: "local" as const, role: "admin" as const };
		expect(await channels.entries("fleet", 0, actor)).toEqual([]);
	});

	test("test flag: a valid emit does not throw and lands normally", async () => {
		process.env.OMP_SQUAD_CARD_SCHEMA_STRICT = "1";
		const channels = store();
		const payload = FIXTURES[TRANSCRIPT_EVENT_PLAN_CARD];
		const entry = await channels.appendManager("fleet", { authorActor: "manager", text: "plan card", event: { kind: TRANSCRIPT_EVENT_PLAN_CARD, payload } });
		expect(entry.event?.payload).toEqual(payload);
	});

	test("an unregistered kind warns once and the card still lands every time", async () => {
		const logs: string[] = [];
		const channels = new ChannelStore(dir, new FileStore(dir), (m) => logs.push(m));
		const payload = { face: { title: "Voice call started" } };
		const first = await channels.appendManager("fleet", { authorActor: "manager", text: "voice call", event: { kind: "voice-call" as never, payload } });
		const second = await channels.appendManager("fleet", { authorActor: "manager", text: "voice call", event: { kind: "voice-call" as never, payload } });
		expect(first.event?.payload).toEqual(payload);
		expect(second.event?.payload).toEqual(payload);
		expect(logs.filter((line) => line.includes("voice-call")).length).toBe(1);
	});

	test("a javascript: href injected past the daemon is rejected in production mode too (logged, card still lands)", async () => {
		const logs: string[] = [];
		const channels = new ChannelStore(dir, new FileStore(dir), (m) => logs.push(m));
		const payload = { face: { title: "x", href: "javascript:alert(document.cookie)" } };
		const entry = await channels.appendManager("fleet", { authorActor: "manager", text: "t", event: { kind: TRANSCRIPT_EVENT_MENTION_STEER, payload } });
		expect(entry.event?.payload).toEqual(payload);
		expect(logs.some((line) => line.includes("card schema"))).toBe(true);
	});
});
