/**
 * Sentinel v0 manager wiring (plans/sentinel-drift-probe, review fix #2) — `SquadManager.onDriftHypothesis`'s
 * runId-turnover guard: `stillLive: () => h.runId != null && rec.run?.snapshot().runId === h.runId`.
 *
 * Before the fix, `stillLive` was `() => rec.run?.snapshot().runId === h.runId`, which evaluates
 * `undefined === undefined → true` whenever a hypothesis carries no `runId` AND the run has already torn
 * down (`rec.run` undefined) — confirming/recording a hypothesis that can never be safely attributed to
 * any live run. `h.runId != null` closes that hole: a runId-less hypothesis must never pass the guard,
 * regardless of `rec.run`'s state.
 *
 * `onDriftHypothesis` is private and fire-and-forget (an un-awaited IIFE), so these tests reach it via
 * `mgr as any` (mirrors scout.test.ts's own `@ts-expect-error` reach into a private field) and flush
 * pending microtasks with a short real delay before asserting on the durable audit log — no real `omp`
 * binary or network call is ever reached because the guard (or the empty-diff abstain path) short-circuits
 * before any judge invocation.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { driftAuditPath } from "../src/drift-audit.ts";
import type { Hypothesis } from "../src/drift-lens.ts";
import { RunAccumulator } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

/** Flush the microtask queue past `onDriftHypothesis`'s un-awaited async IIFE (its own `await confirmDrift(...)`
 *  needs a tick to resume even when confirmDrift resolves near-synchronously). A short real delay is simplest
 *  and robust across the guard-abort path (no I/O) and the abstain-write path (one sync fs append). */
function flush(ms = 30): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedAgent(mgr: SquadManager, id: string, repo: string, worktree: string, featureId?: string): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "working",
		kind: "omp-operator",
		repo,
		worktree,
		branch: "squad/unit",
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		featureId,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, approvalMode: "yolo" };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() });
}

const CRITERIA = [{ id: "c1", text: "must satisfy the declared criterion", completed: false }];

function hypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
	return { kind: "wrong-direction", severity: "medium", agent: "a1", evidence: "went off track", rationale: "chasing an unrelated tangent", at: 1, ...over };
}

test("(fix #2) stillLive rejects a runId-less hypothesis even when rec.run is ALSO undefined (undefined===undefined must NOT pass)", async () => {
	const stateDir = await tmpDir("sentinel-mgr-guard-");
	const mgr = new SquadManager({ stateDir });
	const worktree = await tmpDir("sentinel-mgr-guard-wt-");
	seedAgent(mgr, "a1", worktree, worktree, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo: worktree, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	// rec.run is left undefined (a torn-down / never-started run) — the exact condition the old
	// `undefined === undefined` comparison mishandled.
	expect(mgr.agents.get("a1")?.run).toBeUndefined();

	(mgr as unknown as { onDriftHypothesis: (h: Hypothesis) => void }).onDriftHypothesis(hypothesis({ runId: undefined }));
	await flush();

	expect(() => readFileSync(driftAuditPath(stateDir), "utf8")).toThrow(); // nothing written — the guard aborted
});

test("(fix #2) stillLive also rejects a runId-less hypothesis when the run IS live (still no safe attribution)", async () => {
	const stateDir = await tmpDir("sentinel-mgr-guard2-");
	const mgr = new SquadManager({ stateDir });
	const worktree = await tmpDir("sentinel-mgr-guard2-wt-");
	seedAgent(mgr, "a1", worktree, worktree, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo: worktree, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	const run = new RunAccumulator({ agentId: "a1", name: "a1", repo: worktree });
	run.start();
	const rec = mgr.agents.get("a1");
	if (rec) rec.run = run;

	(mgr as unknown as { onDriftHypothesis: (h: Hypothesis) => void }).onDriftHypothesis(hypothesis({ runId: undefined }));
	await flush();

	expect(() => readFileSync(driftAuditPath(stateDir), "utf8")).toThrow(); // still nothing written
});

test("(fix #2) a genuinely live run (matching runId) passes the guard and confirmDrift writes a record", async () => {
	const stateDir = await tmpDir("sentinel-mgr-live-");
	const mgr = new SquadManager({ stateDir });
	const worktree = await tmpDir("sentinel-mgr-live-wt-"); // not a real git repo — diff degrades to "" (abstain), no `omp` needed
	seedAgent(mgr, "a1", worktree, worktree, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo: worktree, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	const run = new RunAccumulator({ agentId: "a1", name: "a1", repo: worktree });
	run.start();
	const rec = mgr.agents.get("a1");
	if (rec) rec.run = run;
	const liveRunId = run.snapshot().runId;

	(mgr as unknown as { onDriftHypothesis: (h: Hypothesis) => void }).onDriftHypothesis(hypothesis({ runId: liveRunId }));
	await flush();

	const lines = readFileSync(driftAuditPath(stateDir), "utf8").trim().split("\n");
	expect(lines.length).toBe(1);
	const entry = JSON.parse(lines[0]);
	expect(entry.runId).toBe(liveRunId);
	expect(entry.agent).toBe("a1");
	// Empty diff (non-git worktree) ⇒ the judge is never reached — an honest "abstain", not a crash.
	expect(entry.judgeVerdict).toBe("abstain");
});

test("(fix #2) a stale runId (run turned over to a NEW run) is rejected — not just a missing runId", async () => {
	const stateDir = await tmpDir("sentinel-mgr-stale-");
	const mgr = new SquadManager({ stateDir });
	const worktree = await tmpDir("sentinel-mgr-stale-wt-");
	seedAgent(mgr, "a1", worktree, worktree, "f1");
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set("f1", { id: "f1", title: "F1", repo: worktree, createdAt: 0, updatedAt: 0, acceptanceCriteria: CRITERIA });
	const run = new RunAccumulator({ agentId: "a1", name: "a1", repo: worktree });
	run.start();
	const rec = mgr.agents.get("a1");
	if (rec) rec.run = run;

	(mgr as unknown as { onDriftHypothesis: (h: Hypothesis) => void }).onDriftHypothesis(hypothesis({ runId: "a-run-id-from-a-previous-turned-over-run" }));
	await flush();

	expect(() => readFileSync(driftAuditPath(stateDir), "utf8")).toThrow();
});
