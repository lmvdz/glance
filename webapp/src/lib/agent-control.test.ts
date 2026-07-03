import { expect, test } from "bun:test";
import { canLand, landToast, stopCommand, stoppableAgents, verifyToast } from "./agent-control";
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

test("canLand: branch + own worktree lands (ad-hoc agents included); in-place or branchless does not", () => {
  expect(canLand({ branch: "squad/x", worktree: "/wt/x", repo: "/repo" })).toBe(true);
  expect(canLand({ branch: undefined, worktree: "/wt/x", repo: "/repo" })).toBe(false); // nothing to merge
  expect(canLand({ branch: "squad/x", worktree: "/repo", repo: "/repo" })).toBe(false); // in-place: work is already in the checkout
  expect(canLand(null)).toBe(false);
  expect(canLand(undefined)).toBe(false);
});

test("landToast maps merged / staged / blocked outcomes", () => {
  expect(landToast({ ok: true, merged: true, detail: "ff main" })).toEqual({ text: "Landed: ff main", tone: "success" });
  expect(landToast({ ok: true, merged: false })).toEqual({ text: "Land made no merge", tone: "success" });
  expect(landToast({ ok: false, staged: true, detail: "held" }).tone).toBe("info");
  expect(landToast({ ok: false, detail: "no proof — run Verify before landing (or force)" })).toEqual({
    text: "Land blocked: no proof — run Verify before landing (or force)",
    tone: "error",
  });
  expect(landToast({ ok: false })).toEqual({ text: "Land blocked: unknown reason", tone: "error" });
});

test("verifyToast: green proof invites the land, red proof carries the failing tail line", () => {
  expect(verifyToast({ ok: true })).toEqual({ text: "Proof green — this branch can land", tone: "success" });
  expect(verifyToast({ ok: false, detail: "line one\n2 tests failed" })).toEqual({ text: "Proof RED — 2 tests failed", tone: "error" });
  expect(verifyToast({ ok: false })).toEqual({ text: "Proof RED", tone: "error" });
});
