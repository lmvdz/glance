/**
 * Per-run receipt ledger: a pure accumulator fed from the omp event stream
 * plus append-only JSONL persistence. All run-shaped logic lives here so tests
 * drive it directly without spawning a manager or an omp process.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentStatus, ReceiptRollup, RunReceipt } from "./types.ts";

/** Assistant usage shape we care about (subset of pi-catalog `Usage`). */
interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: { total: number };
}

/** Identifying seed for a run, lifted from the agent's DTO. */
export interface RunSeed {
	agentId: string;
	name: string;
	repo: string;
	branch?: string;
	model?: string;
}

/**
 * Mutable, single-run accumulator. Lives for one agent_start..agent_end (or
 * terminal exit) window. `start()` is idempotent so repeated turn_start frames
 * inside one run don't reset counters.
 */
export class RunAccumulator {
	private readonly seed: RunSeed;
	private runId = "";
	private startedAt = 0;
	private endedAt?: number;
	private durationMs?: number;
	private status: AgentStatus = "working";
	private toolCalls = 0;
	private toolTally: Record<string, number> = {};
	private tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	private costUsd?: number;
	private filesTouched: string[] = [];
	private started = false;
	/** Set once finalizeRun has persisted this run; guards double-append. */
	finalized = false;

	constructor(seed: RunSeed) {
		this.seed = { ...seed };
	}

	/** Begin a run. Idempotent within a live run; refreshes model when given. */
	start(model?: string): void {
		if (model) this.seed.model = model;
		if (this.started) return;
		this.started = true;
		this.runId = Date.now().toString(36);
		this.startedAt = Date.now();
		this.toolCalls = 0;
		this.toolTally = {};
		this.tokens = undefined;
		this.costUsd = undefined;
		this.filesTouched = [];
		this.endedAt = undefined;
		this.durationMs = undefined;
	}

	onTool(toolName: string): void {
		this.toolCalls++;
		this.toolTally[toolName] = (this.toolTally[toolName] ?? 0) + 1;
	}

	/** Accumulate one assistant message's usage; lazily creates the aggregate. */
	onAssistantUsage(usage: AssistantUsage): void {
		const t = (this.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		t.input += usage.input ?? 0;
		t.output += usage.output ?? 0;
		t.cacheRead += usage.cacheRead ?? 0;
		t.cacheWrite += usage.cacheWrite ?? 0;
		t.total += usage.totalTokens ?? 0;
		this.costUsd = (this.costUsd ?? 0) + (usage.cost?.total ?? 0);
	}

	finish(status: AgentStatus, filesTouched: string[]): void {
		this.endedAt = Date.now();
		this.durationMs = this.endedAt - this.startedAt;
		this.status = status;
		this.filesTouched = filesTouched;
	}

	/** Immutable copy of the current run state. */
	snapshot(): RunReceipt {
		return {
			agentId: this.seed.agentId,
			name: this.seed.name,
			repo: this.seed.repo,
			branch: this.seed.branch,
			model: this.seed.model,
			runId: this.runId,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			durationMs: this.durationMs,
			status: this.status,
			toolCalls: this.toolCalls,
			toolTally: { ...this.toolTally },
			tokens: this.tokens ? { ...this.tokens } : undefined,
			costUsd: this.costUsd,
			filesTouched: [...this.filesTouched],
		};
	}

	/** Compact summary for the DTO. */
	rollup(): ReceiptRollup {
		return { toolCalls: this.toolCalls, costUsd: this.costUsd, durationMs: this.durationMs, endedAt: this.endedAt };
	}
}

/** A forwarded omp wire frame (only the fields receipts reads). */
type Frame = {
	type?: string;
	toolName?: string;
	message?: { role?: string; usage?: AssistantUsage };
	[k: string]: unknown;
};

/**
 * Map one wire frame onto the accumulator. The SAME logic the manager calls,
 * so the test exercises the real mapping. Unknown frame types are ignored.
 */
export function ingest(acc: RunAccumulator, frame: Frame): void {
	switch (frame.type) {
		case "agent_start":
		case "turn_start":
			acc.start();
			break;
		case "tool_execution_start":
			acc.onTool(typeof frame.toolName === "string" ? frame.toolName : "tool");
			break;
		case "message_end":
			if (frame.message?.role === "assistant" && frame.message.usage) acc.onAssistantUsage(frame.message.usage);
			break;
		// agent_end / exit carry no run data; finalizeRun calls finish() directly.
	}
}

// ── JSONL persistence (Bun/Node stdlib only; no sqlite, no dependency) ────────
//
// ponytail: append-only JSONL under receipts/<agentId>.jsonl. Cheap to write
// and read in run order. Ceiling: no cross-run aggregate queries (per-repo cost
// over time, etc.) and no rotation/retention. Upgrade path: move to sqlite only
// if those aggregate queries become a real need.

export function receiptPath(baseDir: string, agentId: string): string {
	return path.join(baseDir, "receipts", `${agentId}.jsonl`);
}

export async function appendReceipt(baseDir: string, receipt: RunReceipt): Promise<void> {
	const file = receiptPath(baseDir, receipt.agentId);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.appendFile(file, `${JSON.stringify(receipt)}\n`);
}

export async function readReceipts(baseDir: string, agentId: string): Promise<RunReceipt[]> {
	let text: string;
	try {
		text = await fs.readFile(receiptPath(baseDir, agentId), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as RunReceipt);
}
