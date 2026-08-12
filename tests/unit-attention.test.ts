import { describe, expect, test } from "bun:test";
import { EscalationLedger, UnitAttentionLane } from "../src/unit-attention.ts";
import type { AgentDTO, AttentionEvent } from "../src/types.ts";

const session = () => ({ dto: { id: "u1", name: "unit-1", attentionEvents: undefined } as unknown as AgentDTO }) as { dto: AgentDTO };

describe("UnitAttentionLane.raise — the one append-then-emit chokepoint", () => {
	test("appends the event and emits; the returned event carries the minted id", () => {
		const emitted: string[] = [];
		const lane = new UnitAttentionLane({ log: () => {}, emit: (r) => emitted.push(r.dto.id) });
		const rec = session();
		const event = lane.raise(rec, { summary: "look here", detail: "why", source: "notify" });
		expect(rec.dto.attentionEvents).toHaveLength(1);
		expect(rec.dto.attentionEvents?.[0]).toMatchObject({ summary: "look here", detail: "why", source: "notify" });
		expect(rec.dto.attentionEvents?.[0]?.id).toBe(event.id);
		expect(emitted).toEqual(["u1"]);
	});

	test("quiet appends WITHOUT emitting — for sites whose method already broadcasts at its tail", () => {
		const emitted: string[] = [];
		const lane = new UnitAttentionLane({ log: () => {}, emit: (r) => emitted.push(r.dto.id) });
		const rec = session();
		lane.raise(rec, { summary: "s", source: "tool" }, { quiet: true });
		expect(rec.dto.attentionEvents).toHaveLength(1);
		expect(emitted).toEqual([]);
	});

	test("a pre-minted event (membrane/staleness path) keeps its id and createdAt", () => {
		const lane = new UnitAttentionLane({ log: () => {}, emit: () => {} });
		const rec = session();
		const pre: AttentionEvent = { id: "pre-1", summary: "breaker tripped", source: "notify", createdAt: 42 };
		lane.raise(rec, pre);
		expect(rec.dto.attentionEvents?.[0]).toMatchObject({ id: "pre-1", createdAt: 42 });
	});

	test("fail-open BY CONTRACT: a throwing emit is a warn log, never a throw into the raiser's path", () => {
		const warns: string[] = [];
		const lane = new UnitAttentionLane({
			log: (level, msg) => {
				if (level === "warn") warns.push(msg);
			},
			emit: () => {
				throw new Error("socket died");
			},
		});
		const rec = session();
		expect(() => lane.raise(rec, { summary: "s", source: "notify" })).not.toThrow();
		// The append itself landed before the emit blew up — the row survives for the next snapshot.
		expect(rec.dto.attentionEvents).toHaveLength(1);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("non-fatal");
	});
});

describe("EscalationLedger — episode/attempt/once semantics (the five fields it replaced)", () => {
	test("noteEpisode: first sighting and every CHANGE reset the budget; a repeat does not", () => {
		const l = new EscalationLedger();
		expect(l.noteEpisode("r::b", "sha1::dirty")).toBe(true);
		expect(l.bump("r::b")).toBe(1);
		expect(l.noteEpisode("r::b", "sha1::dirty")).toBe(false); // same episode — budget keeps counting
		expect(l.bump("r::b")).toBe(2);
		expect(l.noteEpisode("r::b", "sha2::dirty")).toBe(true); // new commit ⇒ new problem ⇒ fresh budget
		expect(l.bump("r::b")).toBe(1);
	});

	test("escalateOnce fires exactly once per scope — and re-arms only via clear (the heal path)", () => {
		const l = new EscalationLedger();
		expect(l.escalateOnce("r::b")).toBe(true);
		expect(l.escalateOnce("r::b")).toBe(false);
		l.clear("r::b");
		expect(l.escalateOnce("r::b")).toBe(true); // a LATER persistent fault on the same scope can escalate again
	});

	test("noteEpisode re-arms escalateOnce for a NEW episode (per-episode idempotency, not per-scope-forever)", () => {
		const l = new EscalationLedger();
		l.noteEpisode("r::b", "e1");
		expect(l.escalateOnce("r::b")).toBe(true);
		l.noteEpisode("r::b", "e2");
		expect(l.escalateOnce("r::b")).toBe(true);
	});

	test("scopes are independent", () => {
		const l = new EscalationLedger();
		expect(l.bump("a")).toBe(1);
		expect(l.bump("b")).toBe(1);
		l.clear("a");
		expect(l.bump("b")).toBe(2);
	});
});
