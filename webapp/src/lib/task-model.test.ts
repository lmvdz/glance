import { expect, test } from "bun:test";
import { taskFromFeature, taskRef } from "./task-model";
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
  readiness: { ready: false, state: "needs-proof", blockers: ["needs-proof"], nextAction: "Run Verify before landing." },
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
  expect(task.planDir).toBe("plans/web-dashboard");
  expect(task.category).toBe("frontend");
  expect(task.status).toBe("active");
  expect(task.contextBundle.criteria).toBe("2 / 5 workflow steps");
});

test("taskRef prefers a real Plane ticket identifier", () => {
  expect(taskRef({ id: "OMPSQ-306", planDir: "plans/x" })).toBe("OMPSQ-306");
  expect(taskRef({ id: "OMP-1", planDir: undefined })).toBe("OMP-1");
});

test("taskRef falls back to the plan slug when the id is a synthetic feature id", () => {
  expect(taskRef({ id: "plan:repo:plans/visual-plan-demo", planDir: "plans/visual-plan-demo" })).toBe("visual-plan-demo");
  expect(taskRef({ id: "a1b2c3d4-uuid", planDir: "plans/change-driven-loops" })).toBe("change-driven-loops");
});

test("taskRef returns null for a bare synthetic id with no plan dir — no UUID noise in the list", () => {
  expect(taskRef({ id: "a1b2c3d4-9999", planDir: undefined })).toBeNull();
  expect(taskRef({ id: "plan:repo:something", planDir: undefined })).toBeNull();
});

test("taskFromFeature preserves proof provenance and readiness", () => {
  const task = taskFromFeature({ ...feature, worktrees: [{ agentId: "a1", agentName: "Agent", branch: "squad/a1", worktree: "/tmp/wt", changedFiles: 2, ahead: 1, behind: 0, readiness: "ahead", proof: { state: "fresh", ranAt: 123, artifacts: 1 } }], proof: { fresh: 1, failed: 0, stale: 0, none: 0, latestRanAt: 123, artifacts: 1 }, readiness: { ready: true, state: "ready", blockers: [], nextAction: "Land the verified candidate." }, planRevisionCandidates: [{ id: "c1", featureId: "feat-1", repo: feature.repo, planPath: "plans/web-dashboard/01.md", summary: "Tighten acceptance", state: "candidate", createdAt: 1, updatedAt: 1 }] }, [], {
    id: feature.repo,
    name: "omp-squad",
    shortCode: "OS",
    colorClass: "bg-blue-500",
  });

  expect(task.proofProvenance?.source.path).toBe("plans/web-dashboard");
  expect(task.proofProvenance?.worktrees[0]?.proof?.state).toBe("fresh");
  expect(task.proofProvenance?.readiness?.state).toBe("ready");
  expect(task.proofProvenance?.candidates[0]?.summary).toBe("Tighten acceptance");
});
