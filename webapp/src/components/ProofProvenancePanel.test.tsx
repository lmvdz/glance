import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProofProvenancePanel } from "./ProofProvenancePanel";
import type { Task } from "../types";

const task = {
  id: "OMP-1",
  title: "Proof feature",
  category: "backend",
  duration: "1d",
  status: "active",
  description: "",
  acceptanceCriteria: [],
  contextBundle: { spec: "", criteria: "", prerequisites: "", decisions: "", downstream: "" },
  decisions: [],
  relationships: [],
  properties: { status: "REVIEW", priority: null, assignee: null, project: { id: "/r", name: "r", shortCode: "R", colorClass: "bg-blue-500" }, estimate: null },
  tags: [],
  proofProvenance: {
    source: { type: "plan", label: "plans/proof", path: "plans/proof" },
    worktrees: [{ agentId: "a1", agentName: "Agent", branch: "squad/a1", worktree: "/tmp/wt", changedFiles: 2, ahead: 1, behind: 0, readiness: "ahead", proof: { state: "stale", ranAt: 123, artifacts: 2 } }],
    proof: { fresh: 0, failed: 0, stale: 1, none: 0, latestRanAt: 123, artifacts: 2 },
    readiness: { ready: false, state: "proof-stale", blockers: ["proof-stale"], nextAction: "Re-run proof against current HEAD." },
    candidates: [{ id: "c1", featureId: "f1", repo: "/r", planPath: "plans/proof/01.md", summary: "Candidate plan edit", state: "candidate", createdAt: 1, updatedAt: 1 }],
  },
} satisfies Task;

test("ProofProvenancePanel renders source, proof, readiness, worktrees, and candidates", () => {
  const html = renderToStaticMarkup(<ProofProvenancePanel task={task} />);

  expect(html).toContain("Proof &amp; provenance");
  expect(html).toContain("plans/proof");
  expect(html).toContain("stale");
  expect(html).toContain("Re-run proof against current HEAD.");
  expect(html).toContain("squad/a1");
  expect(html).toContain("Candidate plan edit");
});
