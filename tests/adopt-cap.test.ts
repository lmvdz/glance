/**
 * Re-adoption cap (src/squad-manager.ts `selectAdoptable`). On restart the daemon must NOT re-spawn
 * every orphaned worktree at once — that simultaneous burst of omp hosts OOM'd the box. It resumes only
 * agents with unlanded work, capped at the agent ceiling; done/clean ones are dropped.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentsToAdopt, deferredResumable, selectAdoptable, SquadManager } from "../src/squad-manager.ts";
import { FileStore } from "../src/dal/store.ts";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

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

// ── C04: cold-adopt orphan-close (durable pending) ──────────────────────────

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({ todoPhases: [], isStreaming: false } as RpcSessionState);
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

interface TransitionLogEntry {
	agentId: string;
	from: string;
	to: string;
	reason: string;
	at: number;
	cause?: Record<string, unknown>;
	denied?: boolean;
}

interface AdoptHost {
	transitionLog: { recent: () => TransitionLogEntry[] };
	transitionHistory: (id: string, opts?: { full?: boolean }) => Promise<TransitionLogEntry[]>;
}

test("adoptOrphanedAgents on a persisted record with pending produces a fresh agent whose dto.pending starts EMPTY, and records an orphan-close transition", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-pending-state-"));
	tmps.push(stateDir);
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-pending-wt-"));
	tmps.push(worktree);

	const persisted: PersistedAgent = {
		id: "orphan-1",
		name: "orphan",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		// A resumable workflow checkpoint counts as "has work" even with a clean worktree (agentsToAdopt/
		// selectAdoptable's own resumable() rule, mirrored above) — no real git repo needed for this test.
		kind: "workflow",
		workflowState: { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [] },
		pending: [{ id: "orphan-pending-1", source: "ui", kind: "confirm", title: "proceed?", message: "ok?", createdAt: Date.now() }],
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr.start(); // hasState() true -> reconnectLive (no live host) -> adoptOrphanedAgents

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	const dto = roster[0]!;
	expect(dto.id).not.toBe("orphan-1"); // create() always mints a fresh id on adoption
	expect(dto.pending).toEqual([]); // never restored — orphan-close consumes it, doesn't re-populate dto.pending

	const log = (mgr as unknown as AdoptHost).transitionLog.recent().filter((e) => e.agentId === dto.id);
	const orphanClose = log.find((e) => e.reason === "pending-cancel" && (e.cause as { priorId?: string } | undefined)?.priorId === "orphan-1");
	expect(orphanClose).toBeDefined();
	expect(orphanClose?.denied).toBeUndefined();

	const transcript = mgr.getTranscript(dto.id);
	expect(transcript.some((t) => JSON.stringify(t).includes("orphaned by adoption"))).toBe(true);

	await mgr.stop();
});

test("#lifecycle-truth finding 4: cold-adopting an agent with NO pending still stitches lineage — followLineage crosses the id change", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-no-pending-state-"));
	tmps.push(stateDir);
	const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-no-pending-wt-"));
	tmps.push(worktree);

	const persisted: PersistedAgent = {
		id: "orphan-no-pending-1",
		name: "orphan",
		repo: "(none)",
		worktree,
		approvalMode: "yolo",
		// No `pending` at all — the common case. Pre-fix, closeOrphanedPending's lineage-recording
		// transition() call only ran INSIDE the pending-close loop, so this case never recorded an
		// "adopted" entry and followLineage's cause.priorId walk had nothing to stitch across.
		kind: "workflow",
		workflowState: { goal: "g", currentNode: "n1", visits: {}, vars: {}, index: 0, rollup: [] },
	};
	await new FileStore(stateDir).save({ agents: [persisted], transcripts: {}, features: [] });

	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new NoopDriver();
	await mgr.start();

	const roster = mgr.list();
	expect(roster.length).toBe(1);
	const dto = roster[0]!;
	expect(dto.id).not.toBe("orphan-no-pending-1");

	// The unconditional "adopted" entry (#lifecycle-truth finding 4) lands even with no pending to close —
	// pre-fix, "adopted" was dead code for exactly this (the common) case.
	const log = (mgr as unknown as AdoptHost).transitionLog.recent().filter((e) => e.agentId === dto.id);
	const adopted = log.find((e) => e.reason === "adopted" && (e.cause as { priorId?: string } | undefined)?.priorId === "orphan-no-pending-1");
	expect(adopted).toBeDefined();
	expect(adopted?.denied).toBeUndefined();

	// followLineage's cause.priorId walk (via transitionHistory's full:true path) finds the "adopted"
	// entry that names the prior id — there's nothing further to stitch behind it here (the prior id was
	// never itself a live agent in this run, so it recorded no transitions of its own before the crash),
	// but the walk must still terminate cleanly and surface the lineage-tagged entry it does have.
	const full = await (mgr as unknown as AdoptHost).transitionHistory(dto.id, { full: true });
	expect(full.some((e) => e.agentId === dto.id && e.reason === "adopted" && (e.cause as { priorId?: string } | undefined)?.priorId === "orphan-no-pending-1")).toBe(true);

	await mgr.stop();
});
