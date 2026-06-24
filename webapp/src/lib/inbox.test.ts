import { expect, test } from "bun:test";
import type { AgentDTO } from "./dto";
import { foldInbox } from "./inbox";

function agent(id: string, pending: { id: string; createdAt: number }[]): AgentDTO {
  return {
    id,
    name: id,
    status: "input",
    repo: "/r",
    worktree: "/w",
    pending: pending.map((p) => ({ ...p, source: "ui", kind: "confirm", title: "t" })),
    lastActivity: 0,
  };
}

test("folds pending across agents, oldest first", () => {
  const rows = foldInbox([agent("a", [{ id: "r2", createdAt: 200 }]), agent("b", [{ id: "r1", createdAt: 100 }])]);
  expect(rows.map((r) => r.req.id)).toEqual(["r1", "r2"]);
});

test("no pending yields an empty inbox", () => {
  expect(foldInbox([agent("a", [])])).toEqual([]);
});
