/**
 * Re-adoption cap (src/squad-manager.ts `selectAdoptable`). On restart the daemon must NOT re-spawn
 * every orphaned worktree at once — that simultaneous burst of omp hosts OOM'd the box. It resumes only
 * agents with unlanded work, capped at the agent ceiling; done/clean ones are dropped.
 */

import { expect, test } from "bun:test";
import { agentsToAdopt, deferredResumable, selectAdoptable } from "../src/squad-manager.ts";

const ag = (id: string) => ({ id });
const withWork: Record<string, true> = { a: true, c: true, d: true, e: true }; // b is done/clean
const hasWork = (a: { id: string }) => withWork[a.id] === true;

/** A persisted record carries a resumable checkpoint when it's a workflow with workflowState set. */
const resumable = (p: { kind?: string; workflowState?: unknown }): boolean => p.kind === "workflow" && p.workflowState !== undefined;

test("resumes only agents with unlanded work", () => {
	const out = selectAdoptable([ag("a"), ag("b"), ag("c")], hasWork, 10);
	expect(out.map((a) => a.id)).toEqual(["a", "c"]); // b (no work) dropped
});

test("caps the number re-adopted at `cap` (the OOM guard)", () => {
	const out = selectAdoptable([ag("a"), ag("c"), ag("d"), ag("e")], hasWork, 2);
	expect(out.map((a) => a.id)).toEqual(["a", "c"]); // 4 with work, but only 2 fit
});

test("cap<=0 adopts nothing (no headroom under the ceiling)", () => {
	expect(selectAdoptable([ag("a"), ag("c")], hasWork, 0)).toEqual([]);
	expect(selectAdoptable([ag("a")], hasWork, -3)).toEqual([]);
});

test("all-done set adopts nothing regardless of cap", () => {
	expect(selectAdoptable([ag("b"), ag("z")], hasWork, 5)).toEqual([]);
});

// ── C02: checkpoint-authoritative, loss-free adoption (D1) ──────────────────

test("agentsToAdopt excludes parallel-branch children (parentId set) — they land with their parent", () => {
	const persisted = [
		{ id: "run", worktree: "/w/run" }, // a normal orphaned run → adopt
		{ id: "branch", worktree: "/w/branch", parentId: "run" }, // a fan-out child → never adopted alone
	];
	const out = agentsToAdopt(persisted, new Set<string>(), () => true).map((p) => p.id);
	expect(out).toEqual(["run"]);
});

test("deferredResumable preserves the resumable records the ceiling dropped (D1: not erased)", () => {
	const eligible = [
		{ id: "wf1", kind: "workflow", workflowState: { currentNode: "x" } },
		{ id: "wf2", kind: "workflow", workflowState: { currentNode: "y" } },
		{ id: "plain", kind: "omp-operator" }, // no checkpoint → re-dispatches from its issue, not preserved
	];
	const adopted = [eligible[0]!]; // only wf1 fit under the ceiling this boot
	const out = deferredResumable(eligible, resumable, adopted).map((p) => p.id);
	expect(out).toEqual(["wf2"]); // wf2 kept for the next restart; plain not preserved; wf1 already taken
});

test("deferredResumable: a resumable checkpoint counts as work even with no dirty worktree", () => {
	const wf = { id: "wf", kind: "workflow", workflowState: { currentNode: "implement" } };
	// With nothing adopted yet, a resumable run is preserved rather than silently dropped as "done/clean".
	expect(deferredResumable([wf], resumable, []).map((p) => p.id)).toEqual(["wf"]);
	// A workflow record with NO checkpoint is not resumable → not preserved.
	expect(deferredResumable([{ id: "bare", kind: "workflow" }], resumable, [])).toEqual([]);
});
