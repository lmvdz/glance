import { expect, test } from "bun:test";
import type { AgentDTO } from "./dto";
import { foldInbox, inboxActionCount } from "./inbox";

function agent(id: string, pending: { id: string; createdAt: number }[], patch: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: id,
    status: patch.status ?? "input",
    repo: "/r",
    worktree: "/w",
    pending: pending.map((p) => ({ ...p, source: "ui", kind: "confirm", title: "t" })),
    lastActivity: patch.lastActivity ?? 0,
    ...patch,
  };
}

test("folds actionable inbox items oldest first", () => {
  const agents = [
    agent("a", [{ id: "r2", createdAt: 200 }], { landReady: true, lastActivity: 300 }),
    agent("b", [{ id: "r1", createdAt: 100 }], { status: "error", lastActivity: 250 }),
  ];
  const rows = foldInbox(agents);
  expect(rows.map((r) => (r.kind === "pending" ? r.req.id : r.kind))).toEqual(["r1", "r2", "error", "landReady"]);
  expect(inboxActionCount(agents)).toBe(4);
});

test("no actionable items yields an empty inbox", () => {
  expect(foldInbox([agent("a", [], { status: "idle" })])).toEqual([]);
});
