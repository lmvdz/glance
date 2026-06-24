import { expect, test } from "bun:test";
import type { AgentDTO, FeatureDTO } from "./dto";
import { buildGraphModel } from "./graph-model";

function feature(p: Partial<FeatureDTO> & { id: string; title: string }): FeatureDTO {
  return {
    repo: "/home/x/repo",
    stage: "planned",
    agentIds: [],
    unlandedFiles: 0,
    divergent: false,
    blocked: false,
    statusCounts: {},
    ...p,
  };
}

function agent(p: Partial<AgentDTO> & { id: string }): AgentDTO {
  return {
    name: p.id,
    status: "working",
    repo: "/home/x/repo",
    worktree: "/wt",
    pending: [],
    lastActivity: 0,
    ...p,
  };
}

test("each feature becomes one node; stage -> status; taskRef from issue identifier", () => {
  const m = buildGraphModel(
    [feature({ id: "fA", title: "A", issueIdentifiers: ["DAGON-1"] }), feature({ id: "fB", title: "B", stage: "done" })],
    [],
  );
  expect(m.nodes.length).toBe(2);
  const a = m.nodes.find((n) => n.id === "fA")!;
  expect(a.taskRef).toBe("DAGON-1");
  expect(a.status).toBe("planned");
  expect(m.nodes.find((n) => n.id === "fB")!.status).toBe("done");
});

test("taskRef falls back to a short id when no issue identifier", () => {
  const m = buildGraphModel([feature({ id: "plan:repo:onboarding", title: "X" })], []);
  expect(m.nodes[0].taskRef.length).toBeGreaterThan(0);
  expect(m.nodes[0].taskRef).not.toBe("");
});

test("blockedBy on a live agent issue yields a depends_on edge", () => {
  const fA = feature({ id: "fA", title: "A" });
  const fB = feature({ id: "fB", title: "B" });
  const aA = agent({
    id: "aA",
    featureId: "fA",
    issue: { id: "I-A", identifier: "A-1", name: "a", blockedBy: ["I-B"] },
  });
  const aB = agent({ id: "aB", featureId: "fB", issue: { id: "I-B", identifier: "B-1", name: "b" } });
  const m = buildGraphModel([fA, fB], [aA, aB]);
  expect(
    m.edges.some((e) => e.edgeType === "depends_on" && e.sourceTaskId === "fA" && e.targetTaskId === "fB"),
  ).toBe(true);
});

test("unresolvable blockedBy yields no depends_on edge", () => {
  const fA = feature({ id: "fA", title: "A", planDir: "p1" });
  const aA = agent({ id: "aA", featureId: "fA", issue: { id: "I-A", name: "a", blockedBy: ["ghost"] } });
  const m = buildGraphModel([fA], [aA]);
  expect(m.edges.some((e) => e.edgeType === "depends_on")).toBe(false);
});

test("features sharing a planDir get a relates_to edge; different dirs do not", () => {
  const same = buildGraphModel(
    [feature({ id: "f1", title: "1", planDir: "plans/x" }), feature({ id: "f2", title: "2", planDir: "plans/x" })],
    [],
  );
  expect(same.edges.some((e) => e.edgeType === "relates_to")).toBe(true);
  const diff = buildGraphModel(
    [feature({ id: "f1", title: "1", repo: "/r1" }), feature({ id: "f2", title: "2", repo: "/r2" })],
    [],
  );
  expect(diff.edges.some((e) => e.edgeType === "relates_to")).toBe(false);
});

test("agents bucket by featureId; unknown featureId goes to unassigned", () => {
  const f = feature({ id: "f1", title: "1" });
  const onF = agent({ id: "a1", featureId: "f1" });
  const orphan = agent({ id: "a2", featureId: "nope" });
  const noFeat = agent({ id: "a3" });
  const m = buildGraphModel([f], [onF, orphan, noFeat]);
  expect(m.agentsByFeature.get("f1")?.length).toBe(1);
  expect(m.unassigned.length).toBe(2);
});

test("empty input does not throw and returns empty collections", () => {
  const m = buildGraphModel([], []);
  expect(m.nodes).toEqual([]);
  expect(m.edges).toEqual([]);
  expect(m.agentsByFeature.size).toBe(0);
  expect(m.unassigned).toEqual([]);
});

test("node ids are stable across repeated builds (position-cache contract)", () => {
  const fs = [feature({ id: "fA", title: "A" }), feature({ id: "fB", title: "B" })];
  const a = buildGraphModel(fs, []).nodes.map((n) => n.id);
  const b = buildGraphModel(fs, []).nodes.map((n) => n.id);
  expect(a).toEqual(b);
});
