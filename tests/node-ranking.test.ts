import { describe, expect, test } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ACTIVITY_HALF_LIFE_MS, compareActivity } from "../src/memory/nodes.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO } from "../src/types.ts";

const NOW = 1_000_000_000;

function candidate(id: string, lastActivity: number, messageCount = 12) {
	return { id, createdAt: lastActivity - ACTIVITY_HALF_LIFE_MS, lastActivity, messageCount };
}

function agent(id: string, lastActivity: number, createdAt: number): AgentDTO {
	return {
		id,
		name: id,
		status: "working",
		repo: "/repo",
		worktree: "/worktree",
		approvalMode: "yolo",
		pending: [],
		createdAt,
		lastActivity,
		messageCount: 12,
	} as AgentDTO;
}

describe("node activity ranking", () => {
	test("a fresh activity trail outranks an equally active trail left untouched for a half-life", () => {
		const fresh = candidate("fresh", NOW - 1_000);
		const stale = candidate("stale", NOW - ACTIVITY_HALF_LIFE_MS - 1_000);

		// Asserted through `compareActivity`, the seam every caller actually uses: the raw score is an
		// implementation detail, and a test on it can pass while the comparator callers use is wrong.
		expect(compareActivity(fresh, stale, NOW)).toBeLessThan(0);
		expect(compareActivity(stale, fresh, NOW)).toBeGreaterThan(0);
		expect([stale, fresh].sort((a, b) => compareActivity(a, b, NOW)).map(({ id }) => id)).toEqual(["fresh", "stale"]);
	});

	test("SquadManager exposes the ranked roster the state pane already groups into regions", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "node-ranking-manager-"));
		const manager = new SquadManager({ stateDir, skipGlobalJanitors: true });
		try {
			const roster = manager.agents as unknown as Map<string, { dto: AgentDTO; transcript: unknown[]; agent: { detach(): void } }>;
			const now = Date.now();
			roster.set("stale", { dto: agent("stale", now - ACTIVITY_HALF_LIFE_MS - 1_000, now - 2 * ACTIVITY_HALF_LIFE_MS), transcript: [], agent: { detach() {} } });
			roster.set("fresh", { dto: agent("fresh", now - 1_000, now - ACTIVITY_HALF_LIFE_MS), transcript: [], agent: { detach() {} } });

			expect(manager.list().map(({ id }) => id)).toEqual(["fresh", "stale"]);
		} finally {
			await manager.stop();
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
});
