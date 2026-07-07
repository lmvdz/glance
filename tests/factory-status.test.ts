/**
 * factory-status.test.ts — the derivation behind GET /api/factory/status.
 *
 * Proves the four states are distinct and, crucially, that "armed but not fueled" (flag ON, no Plane
 * backlog → the loop never started) is legibly different from "off" and from a productive "moving"
 * fleet — the whole point of the strip. The reason for a not-armed loop is authoritative here (it
 * encodes the manager's `planeRepos().length > 0` gate), not guessed client-side.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AutomationLog, type AutomationRollupRow } from "../src/automation-log.ts";
import { buildFactoryStatus, deriveLandBlockStatus, deriveLoopReport, deriveOverall, FACTORY_FRESHNESS_FLOOR_MS, FACTORY_LOOPS, loopFlagEnabled, type BuildFactoryStatusInput } from "../src/factory-status.ts";

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
		persistFailures: 0,
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

	test("persistFailures passes straight through — the topology write-durability signal", () => {
		expect(buildFactoryStatus(baseInput()).persistFailures).toBe(0);
		expect(buildFactoryStatus(baseInput({ persistFailures: 3 })).persistFailures).toBe(3);
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

describe("deriveLandBlockStatus — the 'fleet cannot land' banner (research-sirvir/01, part 2)", () => {
	const reason = "squad/a1: main checkout /repo has uncommitted tracked changes — refusing to land";

	test("a recent dirty-main refusal raises the banner with the reason + timestamp", () => {
		const b = deriveLandBlockStatus([roll("land", { events: 1, errors: 1, lastAt: NOW - 60_000, lastSkipReason: reason })]);
		expect(b.blocked).toBe(true);
		expect(b.reason).toBe(reason);
		expect(b.at).toBe(NOW - 60_000);
	});

	test("no land row at all → not blocked (the common healthy case)", () => {
		expect(deriveLandBlockStatus([])).toEqual({ blocked: false });
		expect(deriveLandBlockStatus([roll("dispatch", { events: 3, lastAt: NOW })])).toEqual({ blocked: false });
	});

	test("a land row whose NEWEST event carried no skipReason clears the banner (untagged retryable causes stay off it)", () => {
		expect(deriveLandBlockStatus([roll("land", { events: 2, lastAt: NOW - 1_000 })])).toEqual({ blocked: false });
	});

	test("buildFactoryStatus surfaces the banner in the whole snapshot", () => {
		const blocked = buildFactoryStatus(baseInput({ rollup: [roll("land", { events: 1, errors: 1, lastAt: NOW - 5_000, lastSkipReason: reason })] }));
		expect(blocked.landBlocked.blocked).toBe(true);
		expect(blocked.landBlocked.reason).toBe(reason);
		const clean = buildFactoryStatus(baseInput());
		expect(clean.landBlocked).toEqual({ blocked: false });
	});

	// Banner LIVENESS across the freshness-window boundary (review): the manager re-emits the warn per
	// repo condition on a cooldown BELOW the window (LAND_BLOCKED_WARN_COOLDOWN_MS = floor − 60s), so a
	// refusal persisting for LONGER than the window keeps producing fresh rollup rows and the banner
	// never silently self-clears. Driven through the REAL AutomationLog ring + rollup, not a synthetic
	// row — this is the exact pipeline squad-manager's factoryStatus() reads.
	test("banner liveness: cooldown re-emits keep the banner up past the window; without them it self-clears", () => {
		const cooldownMs = FACTORY_FRESHNESS_FLOOR_MS - 60_000; // mirrors LAND_BLOCKED_WARN_COOLDOWN_MS's derivation
		const windowMs = FACTORY_FRESHNESS_FLOOR_MS;
		const emit = (log: AutomationLog, at: number) =>
			log.record({ loop: "land", repo: "/repo", durationMs: 0, level: "warn", skipReason: "dirty-main", detail: reason }, at);
		const dir = mkdtempSync(path.join(os.tmpdir(), "land-banner-liveness-"));
		try {
			// Persisting refusal: first emit at t0, re-emits every cooldown. Check well past the window.
			const withReemits = new AutomationLog(path.join(dir, "a"));
			const t0 = NOW;
			for (let t = t0; t <= t0 + 2 * windowMs; t += cooldownMs) emit(withReemits, t);
			const later = t0 + 2 * windowMs + 30_000; // > 10 minutes of continued refusals, mid-cooldown
			expect(deriveLandBlockStatus(withReemits.rollup(windowMs, later)).blocked).toBe(true);

			// Counterfactual: a single un-re-emitted warn ages out of the window and the banner clears —
			// proving the cooldown MUST stay below the window (the constant derivation, not a coincidence).
			const single = new AutomationLog(path.join(dir, "b"));
			emit(single, t0);
			expect(deriveLandBlockStatus(single.rollup(windowMs, t0 + windowMs + 1)).blocked).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
