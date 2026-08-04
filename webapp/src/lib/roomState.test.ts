import { describe, expect, test } from "bun:test";
import { agentsToRoomNodes, alarmBand, backLabel, duration, foldVerdict, groupByState, handoverSummary, nodeStatusLine, roomViewsFrom, selectionPreview, type RoomNode } from "./roomState";
import { fleetSummary } from "./roomFrame";

const T = 1_000_000_000;

function node(over: Partial<RoomNode> & { id: string; address: string }): RoomNode {
	return { title: `unit ${over.address}`, state: "in-flight", ...over };
}

describe("grouping", () => {
	test("state picks the region; recency only orders within it", () => {
		// A single hot score would let a chatty healthy thread outrank a silent blocked one, which is
		// the exact failure a feed already has.
		const nodes = [
			node({ id: "a", address: "1", state: "in-flight", lastMovementAt: T }),
			node({ id: "b", address: "2", state: "needs-you", lastMovementAt: T - 100_000 }),
			node({ id: "c", address: "3", state: "settled", lastMovementAt: T }),
			node({ id: "d", address: "4", state: "blocked", lastMovementAt: T - 1 }),
		];
		const g = groupByState(nodes);
		expect(g.needsYou.map((n) => n.address)).toEqual(["2"]);
		// blocked and parked live with in-flight: they are work, not achievements.
		expect(g.inFlight.map((n) => n.address)).toEqual(["1", "4"]);
		expect(g.settled.map((n) => n.address)).toEqual(["3"]);
	});
});

describe("the alarm band explains rather than counts", () => {
	test("zero is an achievement with a streak, not an empty list", () => {
		const band = alarmBand([], { sinceMs: T - 6 * 3_600_000 - 12 * 60_000, bestRunMs: 9 * 3_600_000 + 4 * 60_000, now: T });
		expect(band).toContain("unbroken autonomy");
		expect(band).toContain("6h 12m");
		expect(band).toContain("longest run this month 9h 4m");
		// Not a counter, and never the word "empty".
		expect(band).not.toContain("0");
		expect(band.toLowerCase()).not.toContain("empty");
	});

	test("with no streak recorded it says so rather than implying zero", () => {
		// Absence of a measurement is not a measurement of zero.
		expect(alarmBand([], { now: T })).toBe("Nothing has needed you. The fleet has not had to stop for anyone.");
	});

	test("one waiting item states the blast radius of itself", () => {
		expect(alarmBand([node({ id: "a", address: "1", state: "needs-you" })], { now: T })).toContain("Everything else in the fleet is still moving");
	});

	test("several at once is named as a defect in the work, not a task list", () => {
		const band = alarmBand([1, 2, 3].map((n) => node({ id: `${n}`, address: `${n}`, state: "needs-you" })), { now: T });
		expect(band).toContain("defect in the work, not a list for you to keep");
		expect(band).toContain("should not have arrived together");
	});
});

describe("per-node status lines", () => {
	test("blocked says what it waits on AND what waits on it", () => {
		const line = nodeStatusLine(node({ id: "a", address: "3.3", state: "blocked", waitingOn: ["3.2"], dependents: ["3.4", "3.5"] }), T);
		expect(line).toContain("cannot start until 3.2 is decided");
		expect(line).toContain("2 pieces of work are waiting behind it");
	});

	test("a queued node says nobody has picked it up, which is different from working", () => {
		const line = nodeStatusLine(node({ id: "a", address: "1", state: "in-flight", owner: undefined }), T);
		expect(line).toContain("nobody has picked it up");
	});

	test("parked carries NO number — parked is a decision", () => {
		// Concern 13's rule, enforced in the copy: an elapsed time next to parked work reads as overdue.
		const line = nodeStatusLine(node({ id: "a", address: "1", state: "parked", lastMovementAt: T - 50 * 3_600_000 }), T);
		expect(line).toContain("Someone decided this waits");
		// The rule is no ELAPSED NUMBER, not avoidance of the word: an age beside parked work reads as
		// overdue, so the line states outright that it is not, and shows no duration at all.
		expect(line).not.toMatch(/\d+\s*[hm]\b/);
		expect(line).toContain("nothing here is overdue");
	});

	test("every status line for live work states its blast radius", () => {
		for (const state of ["needs-you", "blocked", "in-flight"] as const) {
			const line = nodeStatusLine(node({ id: "a", address: "1", state, owner: state === "in-flight" ? undefined : "Wren" }), T);
			expect(line).toMatch(/Nothing else in the tree depends on it|waiting behind it|Only /);
		}
	});

	test("a node with no dependents says so explicitly", () => {
		expect(nodeStatusLine(node({ id: "a", address: "1", state: "needs-you", owner: "Wren" }), T)).toContain("Nothing else in the tree depends on it");
	});
});

describe("folded runs carry a verdict", () => {
	test("a fold ends in a judgement, not a count", () => {
		const v = foldVerdict({ count: 38, agents: ["Wren", "Pike", "Ash", "Juno", "Tam"], kinds: ["tests", "patches", "two commits"] });
		expect(v).toBe("38 events · Wren, Pike, Ash +2 · tests, patches, two commits · nothing unusual");
	});

	test("when something WAS unusual the fold says that instead", () => {
		// A fold that always says "nothing unusual" is a fold nobody opens.
		expect(foldVerdict({ count: 12, agents: ["Wren"], kinds: ["retries"], unusual: "four retries on the same file" })).toContain("four retries on the same file");
	});
});

describe("select and enter are different acts", () => {
	test("the preview states both the fact and the consequence", () => {
		const p = selectionPreview(node({ id: "a", address: "3.2", title: "the migration" }));
		expect(p).toContain("Press Enter to read its conversation");
		// The reassurance is the point: inspection is safe while reading.
		expect(p).toContain("the room timeline stays where you are");
	});

	test("back is described as returning to where you were reading", () => {
		expect(backLabel("#fleet")).toBe("Back to #fleet — return to the message you were reading.");
	});
});

describe("the quiet screen is a handover", () => {
	const base = { awayMs: 4 * 3_600_000, finished: ["3.1 landed"], changedDirection: [], wentUnanswered: [], omitted: 0 };

	test("it distinguishes finished, changed direction, and unanswered", () => {
		const lines = handoverSummary({ ...base, changedDirection: ["3.4 became two units"], wentUnanswered: ["3.2 asked about the retry window"] });
		expect(lines.join(" ")).toContain("Finished: 3.1 landed");
		expect(lines.join(" ")).toContain("Changed direction");
		expect(lines.join(" ")).toContain("needed you and got no answer");
		expect(lines.join(" ")).toContain("still actionable");
	});

	test("it says what it left out, so a bounded summary never reads as complete", () => {
		expect(handoverSummary({ ...base, omitted: 7 }).join(" ")).toContain("7 quieter events are not listed here");
		// And when nothing was omitted it says THAT, rather than staying silent.
		expect(handoverSummary(base).join(" ")).toContain("That is everything, not a selection.");
	});

	test("nothing unanswered is stated, not implied by absence", () => {
		expect(handoverSummary(base).join(" ")).toContain("Nothing needed you and got no answer.");
	});

	test("nothing finished is stated too", () => {
		expect(handoverSummary({ ...base, finished: [] }).join(" ")).toContain("Nothing finished.");
	});
});

describe("duration reads the way a person would say it", () => {
	test("coarse, because nobody acts on seconds", () => {
		expect(duration(30_000)).toBe("under a minute");
		expect(duration(5 * 60_000)).toBe("5m");
		expect(duration(3_600_000)).toBe("1h");
		expect(duration(3_600_000 + 12 * 60_000)).toBe("1h 12m");
		expect(duration(26 * 3_600_000)).toBe("a day");
		expect(duration(72 * 3_600_000)).toBe("3 days");
		// Negative elapsed (clock skew) never renders as a negative age.
		expect(duration(-5000)).toBe("under a minute");
	});
});

describe("every string explains rather than labels", () => {
	test("no status line is a bare state word", () => {
		// The rule that is hardest to retrofit: a string that only names a state is unfinished.
		for (const state of ["needs-you", "in-flight", "settled", "blocked", "parked"] as const) {
			const line = nodeStatusLine(node({ id: "a", address: "1", state, owner: "Wren" }), T);
			expect(line.length).toBeGreaterThan(30);
			expect(line).toMatch(/\. /); // at least two clauses: the fact, and what it means
		}
	});
});

describe("the roster projected as room state", () => {
	test("a unit with a pending request needs you, whatever its status says", () => {
		// Status is about the process; a pending request is about a person. The person wins.
		const [n] = agentsToRoomNodes([{ id: "a", name: "Wren", status: "working", pending: [{}] }]);
		expect(n!.state).toBe("needs-you");
	});

	test("an errored unit needs a person — it stopped in a way it did not choose", () => {
		expect(agentsToRoomNodes([{ id: "a", status: "error" }])[0]!.state).toBe("needs-you");
	});

	test("finished and stopped work settles off the working surface", () => {
		expect(agentsToRoomNodes([{ id: "a", status: "done" }])[0]!.state).toBe("settled");
		expect(agentsToRoomNodes([{ id: "b", status: "stopped" }])[0]!.state).toBe("settled");
	});

	test("an unknown or missing status stays on the working surface but is NEVER counted as working", () => {
		// Two rules pull in opposite directions and both have to hold. (1) A status nobody recognises
		// must not read as finished, because settled work leaves the working surface and would vanish
		// from view. (2) It must not read as in-flight either — that is a positive claim that work is
		// happening, and the whole point of an unknown status is that we cannot support that claim.
		// `idle` is the only state that satisfies both: visible in the working region, uncounted.
		for (const agent of [{ id: "a", status: "something-new" }, { id: "b" }]) {
			const [node] = agentsToRoomNodes([agent]);
			expect(node!.state).toBe("idle");
			expect(node!.state).not.toBe("settled");
			expect(groupByState([node!]).inFlight).toHaveLength(1);
			expect(groupByState([node!]).settled).toHaveLength(0);
			expect(fleetSummary([node!], 0)).toContain("0 units working");
		}
	});

	test("an idle unit is alive-but-not-working: shown, and excluded from the working count", () => {
		const [node] = agentsToRoomNodes([{ id: "a", name: "Wren", status: "idle" }]);
		expect(node!.state).toBe("idle");
		// Still on the working surface — an existing unit must not disappear.
		expect(groupByState([node!]).inFlight).toEqual([node!]);
		// ...but the top bar must not claim it as work in progress.
		expect(fleetSummary([node!], 0)).toBe("0 units working · 1 idle · 0 plans · nothing waiting on you");
		// And its line says the plain fact rather than dressing idleness up as progress.
		expect(nodeStatusLine(node!, 0)).toContain("idle");
		expect(nodeStatusLine(node!, 0)).not.toContain("is working on it");
	});

	test("a unit spinning up IS in flight; a unit asking for input needs a person", () => {
		expect(agentsToRoomNodes([{ id: "a", status: "starting" }])[0]!.state).toBe("in-flight");
		// Even before a pending request has materialised on the DTO.
		expect(agentsToRoomNodes([{ id: "b", status: "input" }])[0]!.state).toBe("needs-you");
	});

	// The regression in one assertion, in the shape production actually produces: a roster of restored
	// units that all settled to `idle` after reconnecting, none of them executing anything. This is
	// the live daemon's state on 2026-07-29 — seven units adopted, nothing running — which the top bar
	// reported as "7 units working".
	test("seven idle units report as zero working, not seven", () => {
		const nodes = agentsToRoomNodes(Array.from({ length: 7 }, (_, i) => ({ id: `unit-${i}`, status: "idle" })));
		expect(fleetSummary(nodes, 0)).toBe("0 units working · 7 idle · 0 plans · nothing waiting on you");
	});

	test("children become the parent's blast radius", () => {
		const nodes = agentsToRoomNodes([
			{ id: "p", name: "parent" },
			{ id: "c1", name: "child one", parentId: "p" },
			{ id: "c2", name: "child two", parentId: "p" },
		]);
		expect(nodes.find((n) => n.id === "p")!.dependents).toEqual(["child one", "child two"]);
		// And a leaf says so rather than carrying an empty list that renders as nothing.
		expect(nodes.find((n) => n.id === "c1")!.dependents).toBeUndefined();
	});
});

describe("the rail — deduped by id, folded by unit activity", () => {
	test("two rows sharing an id collapse to one, keyed by whichever is seen last", () => {
		// Defensive: the daemon already dedupes and reconciles duplicate-named node channels at list
		// time (src/channels.ts), but a fetch race must never be able to double a row here either.
		const rows = roomViewsFrom(
			[
				{ id: "fleet", name: "#fleet", unreadCount: 0 },
				{ id: "node:a", name: "#ompsq-463", unreadCount: 1 },
				{ id: "node:a", name: "#ompsq-463", unreadCount: 3 },
			],
			[],
		);
		expect(rows.map((r) => r.id)).toEqual(["fleet", "node:a"]);
		expect(rows.find((r) => r.id === "node:a")?.unread).toBe(3);
	});

	test("a node channel whose unit is still active never folds", () => {
		const rows = roomViewsFrom(
			[{ id: "node:a", name: "#ompsq-463", unreadCount: 0 }],
			[{ title: "ompsq-463", state: "in-flight" }],
		);
		expect(rows[0]?.settled).toBe(false);
	});

	test("a node channel whose unit settled folds", () => {
		const rows = roomViewsFrom(
			[{ id: "node:a", name: "#ompsq-463", unreadCount: 0 }],
			[{ title: "ompsq-463", state: "settled" }],
		);
		expect(rows[0]?.settled).toBe(true);
	});

	test("a node channel with no matching unit at all folds too — gone is not different from settled here", () => {
		const rows = roomViewsFrom([{ id: "node:orphan", name: "#ompsq-999", unreadCount: 0 }], []);
		expect(rows[0]?.settled).toBe(true);
	});

	test("#fleet, and any room a person created directly, never fold — they have no unit to settle", () => {
		const rows = roomViewsFrom([{ id: "fleet", name: "#fleet", unreadCount: 0 }], []);
		expect(rows[0]?.kind).toBe("room");
		expect(rows[0]?.settled).toBe(false);
	});

	test("a name lacking the leading # is normalized before it is matched against a unit's title", () => {
		const rows = roomViewsFrom(
			[{ id: "node:a", name: "ompsq-463", unreadCount: 0 }],
			[{ title: "ompsq-463", state: "in-flight" }],
		);
		expect(rows[0]?.name).toBe("#ompsq-463");
		expect(rows[0]?.settled).toBe(false);
	});
});

describe("copy that only breaks on screen", () => {
	test("the omitted-events line agrees in number", () => {
		// Seen live: "1 quieter event are not listed here". Grammar is not a detail in a product whose
		// first law is that the copy IS the design — a reader who catches the machine mis-speaking
		// starts discounting everything else it says.
		const one = handoverSummary({ awayMs: 0, finished: [], changedDirection: [], wentUnanswered: [], omitted: 1 }).join(" ");
		expect(one).toContain("1 quieter event is not listed here");
		expect(one).toContain("it is on its own node.");
		const many = handoverSummary({ awayMs: 0, finished: [], changedDirection: [], wentUnanswered: [], omitted: 3 }).join(" ");
		expect(many).toContain("3 quieter events are not listed here");
		expect(many).toContain("they are on their own nodes.");
	});
});
