/**
 * Receipt model/harness attribution (orchestration receipts audit 2026-07-07): 422/543 fleet receipts
 * carried no `model` and 430/543 no `harness`, starving every cost/outcome scoreboard. Two write-time
 * gaps fed that:
 *   1. `new RunAccumulator(...)` (squad-manager.ts's `agent_start`/`turn_start` handler) never passed
 *      `harness` at all — every daemon-spawned run's receipt fell through to `receipts.ts`'s bare
 *      `?? "omp"` default, mislabeling any non-omp unit.
 *   2. `finalizeRun` snapshotted the accumulator's `seed.model` as-is — a run whose model was never
 *      explicit at start() and never emitted a message-level model before finalize kept an empty model
 *      even though `applyState`'s poll loop had long since backfilled the REAL model onto `rec.dto.model`.
 *
 * Drives the manager's real `onAgentEvent`/`finalizeRun` seam (squad-manager-subagent-lineage.test.ts's
 * pattern) and reads the persisted JSONL receipt back off disk — proof the fix lands at write time, not
 * just in an in-memory snapshot.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { readReceipts } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** A driver that comes up ready immediately and never replays any frames — only the manager's own
 *  onAgentEvent/finalizeRun wiring is exercised (frames are injected directly). */
class ReadyDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}

interface AgentRecordLike {
	dto: AgentDTO;
	options: PersistedAgent;
	run?: unknown;
}

interface ManagerInternals {
	agents: Map<string, AgentRecordLike>;
	onAgentEvent: (rec: AgentRecordLike, frame: { type?: string; [k: string]: unknown }) => void;
	finalizeRun: (rec: AgentRecordLike) => Promise<void>;
}

async function makeMgr(): Promise<{ mgr: SquadManager; repo: string; stateDir: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-attr-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-attr-repo-"));
	tmps.push(stateDir, repo);
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new ReadyDriver();
	return { mgr, repo, stateDir };
}

test("a finalized receipt for an explicit-model, explicit-harness unit carries both, on disk", async () => {
	const { mgr, repo, stateDir } = await makeMgr();
	const dto = await mgr.create({ name: "explicit", repo, approvalMode: "yolo", autoRoute: false, model: "opus", harness: "pi" });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	internals.onAgentEvent(rec, { type: "agent_start" });
	await internals.finalizeRun(rec);

	const [receipt] = await readReceipts(stateDir, dto.id);
	expect(receipt).toBeDefined();
	expect(receipt.model).toBe("opus");
	expect(receipt.harness).toBe("pi"); // NOT the bare "omp" default — the resolved-at-spawn harness
	await mgr.stop();
});

test("a run with no explicit model still carries the applyState-backfilled model on the finalized receipt", async () => {
	const { mgr, repo, stateDir } = await makeMgr();
	// No opts.model: rec.dto.model (and thus the accumulator's seed.model) starts undefined.
	const dto = await mgr.create({ name: "backfilled", repo, approvalMode: "yolo", autoRoute: false });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	internals.onAgentEvent(rec, { type: "agent_start" });
	// Simulate applyState's poll-loop backfill (`state.model` → `rec.dto.model = "${provider}/${id}"`) —
	// a signal INDEPENDENT of the message_end wire frame noteModel() already late-binds from. Before the
	// fix, finalizeRun never re-synced this onto the accumulator, so the receipt kept an empty model.
	rec.dto.model = "anthropic/claude-opus-4-8";
	await internals.finalizeRun(rec);

	const [receipt] = await readReceipts(stateDir, dto.id);
	expect(receipt).toBeDefined();
	expect(receipt.model).toBe("anthropic/claude-opus-4-8");
	expect(receipt.harness).toBe("omp"); // the resolved default harness, stamped even with no opts.harness
	await mgr.stop();
});

test("an explicit start()-time model is never overwritten by a later applyState backfill (first-model-wins holds)", async () => {
	const { mgr, repo, stateDir } = await makeMgr();
	const dto = await mgr.create({ name: "explicit-wins", repo, approvalMode: "yolo", autoRoute: false, model: "opus" });
	const internals = mgr as unknown as ManagerInternals;
	const rec = internals.agents.get(dto.id)!;

	internals.onAgentEvent(rec, { type: "agent_start" });
	rec.dto.model = "anthropic/claude-opus-4-8"; // a poll backfill disagreeing with the explicit choice
	await internals.finalizeRun(rec);

	const [receipt] = await readReceipts(stateDir, dto.id);
	expect(receipt.model).toBe("opus"); // the operator's explicit choice stands
	await mgr.stop();
});
