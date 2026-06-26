import { describe, expect, test } from "bun:test";
import { groupProjects, groupTasks } from "./projects";
import type { AgentDTO, FeatureDTO, IssueRef } from "./dto";

const feat = (id: string, repo: string, extra?: Partial<FeatureDTO>): FeatureDTO => ({
  id,
  title: id,
  repo,
  stage: "planned",
  agentIds: [],
  unlandedFiles: 0,
  divergent: false,
  blocked: false,
  statusCounts: {},
  ...extra,
});
const agent = (id: string, repo: string, status: AgentDTO["status"]): AgentDTO => ({
  id,
  name: id,
  status,
  repo,
  worktree: "/w/" + id,
  pending: [],
  lastActivity: 0,
});
const issue = (id: string, identifier: string): IssueRef => ({ id, identifier, name: id });

describe("groupProjects", () => {
  test("buckets features + agents by repo, attention-first", () => {
    const features = [feat("a", "/r/one"), feat("b", "/r/one"), feat("c", "/r/two")];
    const agents = [agent("x", "/r/one", "working"), agent("y", "/r/two", "input")];
    const projects = groupProjects(features, agents);
    // /r/two has a waiting (input) agent → sorts before /r/one.
    expect(projects.map((p) => p.name)).toEqual(["two", "one"]);
    const one = projects.find((p) => p.name === "one");
    expect(one?.featureCount).toBe(2);
    expect(one?.agentCount).toBe(1);
    expect(one?.waiting).toBe(0);
    expect(projects.find((p) => p.name === "two")?.waiting).toBe(1);
  });

  test("error status also counts as waiting", () => {
    const p = groupProjects([feat("a", "/r")], [agent("x", "/r", "error")]);
    expect(p[0].waiting).toBe(1);
  });

  test("empty input → []", () => {
    expect(groupProjects([], [])).toEqual([]);
  });
});

describe("groupTasks", () => {
  test("buckets issues under the feature that references them; rest unplanned", () => {
    const features = [feat("f1", "/r", { issueIdentifiers: ["OMPSQ-1", "OMPSQ-2"] })];
    const issues = [issue("i1", "OMPSQ-1"), issue("i2", "OMPSQ-2"), issue("i3", "OMPSQ-9")];
    const { byFeature, unplanned } = groupTasks(features, issues);
    expect(byFeature[0].tasks.map((t) => t.id)).toEqual(["i1", "i2"]);
    expect(unplanned.map((t) => t.id)).toEqual(["i3"]);
  });

  test("identifier match is case-insensitive", () => {
    const { byFeature } = groupTasks([feat("f", "/r", { issueIdentifiers: ["ompsq-5"] })], [issue("i", "OMPSQ-5")]);
    expect(byFeature[0].tasks).toHaveLength(1);
  });

  test("a feature with no issueIdentifiers claims nothing", () => {
    const { byFeature, unplanned } = groupTasks([feat("f", "/r")], [issue("i", "OMPSQ-1")]);
    expect(byFeature[0].tasks).toHaveLength(0);
    expect(unplanned).toHaveLength(1);
  });
});
