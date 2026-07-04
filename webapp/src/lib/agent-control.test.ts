import { expect, test } from "bun:test";
import { canLand, fetchCheckpoints, forkCommand, landToast, resolveForkTarget, stopCommand, stoppableAgents, verifyToast, type CheckpointEntryDTO } from "./agent-control";
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

test("forkCommand('a1', 3) returns a fork command carrying that checkpoint seq", () => {
  expect(forkCommand("a1", 3)).toEqual({ type: "fork", id: "a1", seq: 3 });
});

function checkpoint(seq: number, currentNode = "verify"): CheckpointEntryDTO {
  return { seq, at: seq * 1000, currentNode };
}

test("resolveForkTarget defaults to the latest checkpoint's seq when nothing is explicitly selected", () => {
  const checkpoints = [checkpoint(1), checkpoint(3), checkpoint(2)];
  expect(resolveForkTarget("a1", checkpoints, null)).toEqual({ type: "fork", id: "a1", seq: 3 });
});

test("resolveForkTarget honors an explicitly selected earlier checkpoint's seq", () => {
  const checkpoints = [checkpoint(1), checkpoint(2), checkpoint(3)];
  expect(resolveForkTarget("a1", checkpoints, 1)).toEqual({ type: "fork", id: "a1", seq: 1 });
});

test("resolveForkTarget returns undefined when no checkpoints have been fetched yet (nothing to fork from)", () => {
  expect(resolveForkTarget("a1", [], null)).toBeUndefined();
});

test("fetchCheckpoints returns the daemon's parsed checkpoint list", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => [{ seq: 1, at: 100, currentNode: "verify" }] }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchCheckpoints("a1")).toEqual([{ seq: 1, at: 100, currentNode: "verify" }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchCheckpoints degrades to [] instead of throwing when an old daemon 404s the route", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, text: async () => "not found" }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchCheckpoints("a1")).toEqual([]);
  } finally {
    globalThis.fetch = original;
  }
});
