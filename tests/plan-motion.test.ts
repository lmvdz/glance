import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor } from "../src/types.ts";
import { assessPlanMotion, planMotionMetrics } from "../src/plan-motion.ts";
import type { PlanMotionRecord } from "../src/node-records.ts";

const minute = 60_000;

function unit(id: string, movementsAt: number[], extra: Partial<{ blockedCause: string; eligibleSuccessor: boolean }> = {}) {
	return { id, movementsAt, eligibleSuccessor: false, ...extra };
}

describe("plan motion", () => {
	test("measures each plan against its own observed normal rather than a global timeout", () => {
		const fast = assessPlanMotion({
			planId: "fast",
			planTitle: "Fast plan",
			now: 120 * minute,
			units: [unit("fast-1", [0, 10 * minute, 20 * minute])],
		});
		const slow = assessPlanMotion({
			planId: "slow",
			planTitle: "Slow plan",
			now: 120 * minute,
			units: [unit("slow-1", [0, 100 * minute])],
		});

		expect(fast.record.baselineMs).toBe(10 * minute);
		expect(slow.record.baselineMs).toBe(100 * minute);
		expect(fast.stalled).toBe(true);
		expect(slow.stalled).toBe(false);
	});

	test("never judges parked or intentionally still work, and leaves it numberless", () => {
		for (const stillness of [{ parked: true }, { intentionalStill: true }]) {
			const assessment = assessPlanMotion({
				planId: "parked",
				planTitle: "Parked plan",
				now: 500 * minute,
				units: [unit("u1", [0, 10 * minute])],
				...stillness,
			});
			expect(assessment.stalled).toBe(false);
			expect(assessment.record.baselineMs).toBeUndefined();
			expect(assessment.message).toBeUndefined();
		}
	});

	test("writes one planner sentence with the cause, radius, recoveries, and unaffected work", () => {
		const assessment = assessPlanMotion({
			planId: "reindex",
			planTitle: "Search reindex",
			now: 1000 * minute,
			units: [unit("u1", [0, 10 * minute], { blockedCause: "a credential is missing", eligibleSuccessor: false })],
			unaffectedPlanTitles: ["Payments retry", "Auth service"],
		});

		expect(assessment.message).toContain("a credential is missing");
		expect(assessment.message).toContain("no eligible successor can pick it up");
		expect(assessment.message).toContain("Nothing else is affected: Payments retry, Auth service are still moving.");
		expect(assessment.recoveryOptions).toHaveLength(3);
	});

	test("reports noticed and false-positive evidence separately", () => {
		const records: PlanMotionRecord[] = [
			{ id: "noticed", nodeId: "p", kind: "plan-motion", createdAt: 1_000, lastMeaningfulMovementAt: 1, baselineMs: minute, baselineSampleSize: 1, parked: false, intentionalStill: false, eligibleSuccessorCount: 0, noticedAt: 1_000 },
			{ id: "false", nodeId: "p", kind: "plan-motion", createdAt: 2_000, lastMeaningfulMovementAt: 1, baselineMs: minute, baselineSampleSize: 1, parked: false, intentionalStill: false, eligibleSuccessorCount: 0, noticedAt: 2_000, outcome: "false-positive" },
		];
		expect(planMotionMetrics(records, 3_000)).toEqual({ noticed: 2, falsePositive: 1 });
	});
	test("persists one notice and emits it as a planner conversation entry", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-motion-manager-"));
		const manager = new SquadManager({ stateDir, skipGlobalJanitors: true });
		const actor: Actor = { id: "db:planner-test", displayName: "planner test", origin: "local", role: "admin", orgId: "org-a" };
		try {
			await manager.start();
			const input = {
				planId: "search-reindex",
				planTitle: "Search reindex",
				now: 1000 * minute,
				units: [unit("u1", [0, 10 * minute], { blockedCause: "a credential is missing" })],
				unaffectedPlanTitles: ["Payments retry"],
			};
			await manager.assessPlanMotion(input);
			await manager.assessPlanMotion(input);
			const entries = await manager.channelEntries("fleet", 0, actor);
			expect(entries.filter((entry) => entry.authorActor === "planner")).toHaveLength(1);
			expect(entries[0]?.text).toContain("Noticing, not alarming.");
		} finally {
			await manager.stop();
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
});
