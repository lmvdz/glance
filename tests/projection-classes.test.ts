import { expect, test } from "bun:test";
import { ForgedCardError, assertAuthentic, projectionClasses, projectionFor, projectsToRoom, type CardProvenance } from "../src/projection-classes.ts";
import {
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_NEEDS_YOU,
	TRANSCRIPT_EVENT_UNIT_SPAWNED,
	TRANSCRIPT_EVENT_UNIT_TURN_FINISHED,
	TRANSCRIPT_EVENT_VERIFICATION_RAN,
} from "../src/transcript-event-kinds.ts";

const good: CardProvenance = { nodeId: "n1", agentId: "wren", evidenceIds: ["unit-1"] };

test("every class declares WHY it does or does not reach a person", () => {
	// A projection table with no reasons is a volume knob with more steps. Each entry has to be
	// arguable by someone who disagrees with it.
	for (const [kind, cls] of Object.entries(projectionClasses)) {
		expect(cls.because.length).toBeGreaterThan(40);
		expect(cls.because).not.toContain(kind);
	}
});

test("the room is small, and lifecycle telemetry is not in it", () => {
	expect(projectsToRoom(TRANSCRIPT_EVENT_NEEDS_YOU)).toBe(true);
	expect(projectsToRoom(TRANSCRIPT_EVENT_GATE_VERDICT)).toBe(true);
	// The 544-card firehose, by name. None of these interrupt anyone.
	for (const kind of [TRANSCRIPT_EVENT_UNIT_SPAWNED, TRANSCRIPT_EVENT_UNIT_TURN_FINISHED, TRANSCRIPT_EVENT_VERIFICATION_RAN]) {
		expect(projectsToRoom(kind)).toBe(false);
	}
	// "Tests ran" is not a result; the verdict is. That distinction is the whole of concern 27.
	expect(projectionFor(TRANSCRIPT_EVENT_VERIFICATION_RAN).because).toContain("not a result");
});

test("an unclassified event stays at its node — silence is the safe default here", () => {
	// Deliberately the OPPOSITE default from the delegation boundary, and for a stated reason: there,
	// an unclassified action taken autonomously is refused, because the cost of a wrong guess is an
	// irreversible act. Here the cost of a missed card is that someone looks at the node, and the cost
	// of an unearned one is that every card beside it stops being read.
	expect(projectsToRoom("something-nobody-has-classified")).toBe(false);
	expect(projectionFor("something-nobody-has-classified").because).toContain("Nobody has decided");
	expect(projectionFor("something-nobody-has-classified").requiresEvidence).toBe(false);
});

test("a unit cannot author a card about another unit's work", () => {
	// The forgery that matters: a card landing in a room describing work its emitter does not own.
	const forged: CardProvenance = { nodeId: "someone-else", agentId: "wren", evidenceIds: ["x"] };
	const err = (() => { try { assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, forged, "n1"); } catch (e) { return e as Error; } })();
	expect(err).toBeInstanceOf(ForgedCardError);
	expect(err!.message).toContain("speaks for itself and nothing else");
	// Its own node is fine.
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, good, "n1")).not.toThrow();
});

test("a card that interrupts a person carries evidence or the rule that decided it", () => {
	const bare: CardProvenance = { nodeId: "n1", agentId: "wren" };
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, bare, "n1")).toThrow(ForgedCardError);
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, { ...bare, evidenceIds: [] }, "n1")).toThrow(/carries neither/);
	// Either satisfies it: openable evidence, or the rule whose sentence can be quoted at the point it acted.
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, { ...bare, evidenceIds: ["u1"] }, "n1")).not.toThrow();
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, { ...bare, ruleId: "rule-4" }, "n1")).not.toThrow();
	// A node card may be bare — nobody is being interrupted, so nothing has to be proven to them.
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_UNIT_SPAWNED, bare, "n1")).not.toThrow();
});

test("the forgery check runs before the evidence check", () => {
	// Both wrong: the answer names the forgery, because "you are claiming someone else's work" is the
	// more important thing to say and the evidence complaint would be a distraction.
	const bad: CardProvenance = { nodeId: "elsewhere", agentId: "wren" };
	expect(() => assertAuthentic(TRANSCRIPT_EVENT_NEEDS_YOU, bad, "n1")).toThrow(/speaks for itself/);
});
