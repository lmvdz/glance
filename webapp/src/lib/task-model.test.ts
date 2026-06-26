import { expect, test } from "bun:test";
import { taskFromFeature } from "./task-model";
import type { FeatureDTO } from "./dto";

const feature: FeatureDTO = {
  id: "feat-1",
  title: "Build web dashboard",
  repo: "/tmp/omp-squad",
  stage: "in-progress",
  planDir: "plans/web-dashboard",
  agentIds: ["a1"],
  unlandedFiles: 0,
  divergent: false,
  blocked: false,
  statusCounts: { working: 1 },
  issueIdentifiers: ["OMP-1"],
  workflowProgress: { done: 2, total: 5 },
};

test("taskFromFeature preserves the starter task shape with live feature ids", () => {
  const task = taskFromFeature(feature, [{ id: "a1", name: "Agent", status: "working", repo: feature.repo, worktree: "/tmp/wt", pending: [], lastActivity: 1, featureId: feature.id }], {
    id: feature.repo,
    name: "omp-squad",
    shortCode: "OS",
    colorClass: "bg-blue-500",
  });

  expect(task.id).toBe("OMP-1");
  expect(task.sourceId).toBe("feat-1");
  expect(task.category).toBe("frontend");
  expect(task.status).toBe("active");
  expect(task.contextBundle.criteria).toBe("2 / 5 workflow steps");
});
