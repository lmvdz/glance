import { describe, expect, test } from "bun:test";
import { renderAgentRoster } from "../src/index.ts";
import type { AgentDTO } from "../src/types.ts";

function agent(overrides: Partial<AgentDTO> = {}): AgentDTO {
	return {
		id: "a1",
		name: "builder",
		status: "working",
		kind: "omp-operator",
		repo: "/repo",
		worktree: "/repo/.worktrees/builder",
		branch: "squad/builder",
		approvalMode: "write",
		activity: "editing src/index.ts",
		pending: [],
		lastActivity: 123,
		messageCount: 4,
		...overrides,
	};
}

describe("renderAgentRoster", () => {
	test("keeps the existing human roster output", () => {
		expect(renderAgentRoster([agent()])).toBe("working  builder  squad/builder        editing src/index.ts\n");
		expect(renderAgentRoster([])).toBe("no agents\n");
	});

	test("--json emits the full machine-readable roster, including an empty roster", () => {
		const agents = [agent({ pending: [{ id: "p1", source: "tool", kind: "approval", title: "Proceed?", createdAt: 456 }] })];
		const parsed = JSON.parse(renderAgentRoster(agents, { json: true }));
		expect(parsed).toEqual(agents);
		expect(renderAgentRoster([], { json: true })).toBe("[]\n");
	});
});
