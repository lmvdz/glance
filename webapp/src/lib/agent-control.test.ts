import { expect, test } from "bun:test";
import { stoppableAgents, stopCommand } from "./agent-control";
import type { AgentDTO } from "./dto";

const agent = (id: string, status: AgentDTO["status"]): AgentDTO =>
  ({ id, name: id, status, repo: "/r", worktree: "/w", approvalMode: "write", pending: [], lastActivity: 0, messageCount: 0 } as AgentDTO);

test("stoppableAgents keeps non-terminal agents (working/starting/input/idle), drops stopped/error", () => {
  const agents = [
    agent("a", "working"),
    agent("b", "starting"),
    agent("c", "input"),
    agent("d", "idle"),
    agent("e", "stopped"),
    agent("f", "error"),
  ];
  expect(stoppableAgents(agents).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
});

test("stoppableAgents is empty when every agent is terminal (button hides)", () => {
  expect(stoppableAgents([agent("a", "stopped"), agent("b", "error")])).toEqual([]);
  expect(stoppableAgents([])).toEqual([]);
});

test("stopCommand builds a kill command for the given agent id (keeps it restartable)", () => {
  expect(stopCommand("probe-123")).toEqual({ type: "kill", id: "probe-123" });
});
