/**
 * factory-status.test.ts — the derivation behind GET /api/factory/status.
 *
 * Proves the four states are distinct and, crucially, that "armed but not fueled" (flag ON, no Plane
 * backlog → the loop never started) is legibly different from "off" and from a productive "moving"
 * fleet — the whole point of the strip. The reason for a not-armed loop is authoritative here (it
 * encodes the manager's `planeRepos().length > 0` gate), not guessed client-side.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationRollupRow } from "../src/automation-log.ts";
import { buildFactoryStatus, deriveLoopReport, deriveOverall, FACTORY_LOOPS, loopFlagEnabled, type BuildFactoryStatusInput } from "../src/factory-status.ts";

const NOW = 1_700_000_000_000;

function roll(loop: string, p: Partial<AutomationRollupRow> = {}): AutomationRollupRow {
	return { loop, events: 0, llmCalls: 0, found: 0, filed: 0, spawned: 0, errors: 0, lastAt: 0, ...p };
}

/** All backlog loops armed & ticking; a fully-fueled, quiet fleet by default. */
function baseInput(over: Partial<BuildFactoryStatusInput> = {}): BuildFactoryStatusInput {
	return {
		now: NOW,
		env: {},
		planeRepoCount: 1,
		rollup: [],
		liveArmed: { dispatch: true, observer: true, scout: true, opportunity: true, autodrive: true, autoland: true },
		activeAgents: 0,
		...over,
	};
}

const spec = (loop: string) => FACTORY_LOOPS.find((l) => l.loop === loop)!;

describe("loopFlagEnabled", () => {
	test("default-on unless explicitly '0'", () => {
		expect(loopFlagEnabled({}, "OMP_SQUAD_AUTODISPATCH")).toBe(true);
		expect(loopFlagEnabled({ OMP_SQUAD_AUTODISPATCH: "1" }, "OMP_SQUAD_AUTODISPATCH")).toBe(true);
		expect(loopFlagEnabled({ OMP_SQUAD_AUTODISPATCH: "0" }, "OMP_SQUAD_AUTODISPATCH")).toBe(false);
	});
});

describe("deriveLoopReport — the four states", () => {
	test("off: flag disabled → off, no arming reason", () => {
		const r = deriveLoopReport(spec("dispatch"), baseInput({ env: { OMP_SQUAD_AUTODISPATCH: "0" }, liveArmed: { dispatch: false } }));
		expect(r.status).toBe("off");
		expect(r.flagEnabled).toBe(false);
		expect(r.notArmedReason).toBeUndefined();
	});

	test("not-armed (the real current state): flag ON but no backlog → not-armed with the authoritative reason + fix", () => {
		const r = deriveLoopReport(spec("dispatch"), baseInput({ planeRepoCount: 0, liveArmed: { dispatch: false } }));
		expect(r.status).toBe("not-armed");
		expect(r.flagEnabled).toBe(true);
		expect(r.armed).toBe(false);
		expect(r.notArmedReason).toContain("no Plane backlog");
		expect(r.fix).toContain(".plane.json");
	});

	test("not-armed is DISTINCT from off — same loop, backlog-vs-flag differs the reason", () => {
		const off = deriveLoopReport(spec("scout"), baseInput({ env: { OMP_SQUAD_SCOUT: "0" }, liveArmed: { scout: false } }));
		const unfueled = deriveLoopReport(spec("scout"), baseInput({ planeRepoCount: 0, liveArmed: { scout: false } }));
		expect(off.status).toBe("off");
		expect(unfueled.status).toBe("not-armed");
		expect(unfueled.notArmedReason).toBeDefined();
	});

	test("idle: armed, ticking fresh, no output → idle with the skip reason surfaced", () => {
		const r = deriveLoopReport(
			spec("dispatch"),
			baseInput({ rollup: [roll("dispatch", { events: 5, lastAt: NOW - 30_000, lastSkipReason: "all open issues already claimed or dispatched" })] }),
		);
		expect(r.status).toBe("idle");
		expect(r.lastSkipReason).toBe("all open issues already claimed or dispatched");
		expect(r.secondsSinceLastTick).toBe(30);
		expect(r.stale).toBe(false);
	});

	test("moving: armed, fresh tick, produced work → moving", () => {
		const r = deriveLoopReport(spec("scout"), baseInput({ rollup: [roll("scout", { events: 4, filed: 2, found: 3, lastAt: NOW - 10_000 })] }));
		expect(r.status).toBe("moving");
	});

	test("moving: dispatch with agents in the roster counts as motion even with no fresh spawn", () => {
		const r = deriveLoopReport(spec("dispatch"), baseInput({ activeAgents: 2, rollup: [roll("dispatch", { events: 3, lastAt: NOW - 5_000 })] }));
		expect(r.status).toBe("moving");
	});

	test("idle-stale: armed but no fresh heartbeat → idle + stale flag (still alive, honestly flagged)", () => {
		const r = deriveLoopReport(spec("observer"), baseInput({ rollup: [roll("observer", { events: 1, lastAt: NOW - 3_600_000 })] }));
		expect(r.status).toBe("idle");
		expect(r.stale).toBe(true);
		expect(r.lastSkipReason).toContain("last heartbeat");
	});

	test("armed heartbeat loop that never ticked → idle awaiting first heartbeat", () => {
		const r = deriveLoopReport(spec("opportunity"), baseInput({ rollup: [] }));
		expect(r.status).toBe("idle");
		expect(r.secondsSinceLastTick).toBeUndefined();
		expect(r.lastSkipReason).toContain("awaiting first heartbeat");
	});
});

describe("mode loops (autodrive/autoland — no heartbeat, move with the roster)", () => {
	test("autodrive armed, agents present → moving", () => {
		const r = deriveLoopReport(spec("autodrive"), baseInput({ activeAgents: 1 }));
		expect(r.status).toBe("moving");
	});

	test("autoland armed, no agents → idle with a nothing-to-land reason", () => {
		const r = deriveLoopReport(spec("autoland"), baseInput({ activeAgents: 0 }));
		expect(r.status).toBe("idle");
		expect(r.lastSkipReason).toContain("land");
	});

	test("autodrive is NOT gated on backlog — armed with zero Plane repos", () => {
		const r = deriveLoopReport(spec("autodrive"), baseInput({ planeRepoCount: 0, activeAgents: 1 }));
		expect(r.status).toBe("moving");
	});
});

describe("deriveOverall", () => {
	const rep = (status: string) => ({ status } as never);

	test("any moving loop → moving", () => {
		expect(deriveOverall([rep("moving"), rep("idle")], 0)).toBe("moving");
	});

	test("agents in flight force moving even if all loops idle", () => {
		expect(deriveOverall([rep("idle"), rep("idle")], 3)).toBe("moving");
	});

	test("not-armed outranks idle (loud, actionable)", () => {
		expect(deriveOverall([rep("idle"), rep("not-armed")], 0)).toBe("not-armed");
	});

	test("all off → off", () => {
		expect(deriveOverall([rep("off"), rep("off")], 0)).toBe("off");
	});
});

describe("buildFactoryStatus — the whole snapshot", () => {
	test("the real 'not fueled' state: backlog loops not-armed, self-drive idle, overall not-armed", () => {
		const s = buildFactoryStatus(
			baseInput({
				planeRepoCount: 0,
				liveArmed: { dispatch: false, observer: false, scout: false, opportunity: false, autodrive: true, autoland: true },
			}),
		);
		expect(s.overall).toBe("not-armed");
		expect(s.planeRepoCount).toBe(0);
		const dispatch = s.loops.find((l) => l.loop === "dispatch")!;
		expect(dispatch.status).toBe("not-armed");
		expect(dispatch.fix).toBeDefined();
		const autodrive = s.loops.find((l) => l.loop === "autodrive")!;
		expect(autodrive.status).toBe("idle");
		// Every declared loop appears — the strip renders all six.
		expect(s.loops).toHaveLength(FACTORY_LOOPS.length);
	});

	test("a fueled, producing fleet reads moving", () => {
		const s = buildFactoryStatus(
			baseInput({
				activeAgents: 2,
				rollup: [roll("dispatch", { events: 3, spawned: 1, lastAt: NOW - 5_000 }), roll("scout", { events: 4, filed: 2, lastAt: NOW - 8_000 })],
			}),
		);
		expect(s.overall).toBe("moving");
		expect(s.activeAgents).toBe(2);
	});

	test("everything disabled reads off", () => {
		const s = buildFactoryStatus(
			baseInput({
				env: { OMP_SQUAD_AUTODISPATCH: "0", OMP_SQUAD_OBSERVE: "0", OMP_SQUAD_SCOUT: "0", OMP_SQUAD_OPPORTUNITY: "0", OMP_SQUAD_AUTODRIVE: "0", OMP_SQUAD_AUTOLAND: "0" },
				liveArmed: {},
			}),
		);
		expect(s.overall).toBe("off");
		expect(s.loops.every((l) => l.status === "off")).toBe(true);
	});
});
