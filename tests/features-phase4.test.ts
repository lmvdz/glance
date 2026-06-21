/**
 * Phase 4 — Fabro orchestration: a feature's stage tracks its workflow agent's live node.
 *
 * Pure over the agent roster: the member workflow agent uses worktree === repo (⇒ "no-branch",
 * no git) and a non-existent repo path (plan scan + worktreeDiff both catch), so no fixtures.
 */

import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { buildFeatures } from "../src/features.ts";
import type { AgentDTO, PersistedFeature } from "../src/types.ts";

const REPO = path.join(os.tmpdir(), "omp-squad-p4-" + Math.random().toString(36).slice(2));

function wfAgent(active: string | undefined, done = 1, total = 6): AgentDTO {
	return {
		id: "wf1",
		name: "auto",
		status: "working",
		kind: "workflow",
		repo: REPO,
		worktree: REPO,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		featureId: "f1",
		todo: active ? { done, total, active } : undefined,
	};
}

const pf: PersistedFeature = { id: "f1", title: "Auto", repo: REPO, workflowAgentId: "wf1", createdAt: 0, updatedAt: 0 };

test("buildFeatures: a Fabro feature takes its granular stage from the live workflow node", async () => {
	const feats = await buildFeatures(REPO, [wfAgent("Implement", 3, 6)], [pf]);
	const f = feats.find((x) => x.id === "f1");
	expect(f?.stage).toBe("in-progress");
	expect(f?.workflowStage).toBe("Implement");
	expect(f?.workflowProgress).toEqual({ done: 3, total: 6 });
	expect(f?.workflowAgentId).toBe("wf1");
});

test("buildFeatures: workflow nodes map to the right board lanes (the node overrides evidence)", async () => {
	const cases: [string, string][] = [
		["Research", "planned"], // a plain working agent would derive "in-progress" — the node forces "planned"
		["Plan", "planned"],
		["File to Plane", "issues-created"],
		["Implement", "in-progress"],
		["Verify", "review"],
		["Fixup", "review"],
	];
	for (const [active, stage] of cases) {
		const feats = await buildFeatures(REPO, [wfAgent(active)], [pf]);
		expect(feats.find((x) => x.id === "f1")?.stage).toBe(stage);
	}
});

test("buildFeatures: with no active workflow node, stage falls back to evidence", async () => {
	const feats = await buildFeatures(REPO, [wfAgent(undefined)], [pf]);
	const f = feats.find((x) => x.id === "f1");
	expect(f?.workflowStage).toBeUndefined();
	expect(f?.stage).toBe("in-progress"); // evidence: a working member, no node info
});
