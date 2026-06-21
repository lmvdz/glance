/**
 * escalationPayload — when an agent transition should push a human-attention alert.
 */

import { expect, test } from "bun:test";
import { escalationPayload } from "../src/server.ts";
import type { AgentDTO, AgentStatus, PendingRequest } from "../src/types.ts";

function agent(status: AgentStatus, over: Partial<AgentDTO> = {}): AgentDTO {
	return { id: "a1", name: "alpha", status, kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

test("no alert before seeding, on first sight, or on a no-op transition", () => {
	expect(escalationPayload(undefined, agent("input"), false)).toBeNull(); // daemon not seeded yet
	expect(escalationPayload(undefined, agent("input"), true)).toBeNull(); // first time we see the agent
	expect(escalationPayload("input", agent("input"), true)).toBeNull(); // status unchanged
});

test("alerts on transition into input with the pending title + agent deep link", () => {
	const pending: PendingRequest = { id: "p1", source: "ui", kind: "select", title: "approve deploy?", createdAt: 0 };
	const p = escalationPayload("working", agent("input", { pending: [pending] }), true);
	expect(p?.title).toContain("needs you");
	expect(p?.body).toBe("approve deploy?");
	expect(p?.url).toBe("/#/agent/a1");
	expect(p?.tag).toBe("a1");
});

test("alerts on transition into error with the error text", () => {
	const p = escalationPayload("working", agent("error", { error: "child crashed" }), true);
	expect(p?.title).toContain("errored");
	expect(p?.body).toBe("child crashed");
});

test("input alert falls back when there is no pending title", () => {
	expect(escalationPayload("working", agent("input"), true)?.body).toBe("waiting for input");
});

test("no alert when transitioning into a calm state", () => {
	expect(escalationPayload("working", agent("idle"), true)).toBeNull();
	expect(escalationPayload("input", agent("working"), true)).toBeNull();
	expect(escalationPayload("starting", agent("working"), true)).toBeNull();
});
