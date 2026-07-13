/**
 * Per-run receipt ledger: a pure accumulator fed from the omp event stream
 * plus append-only JSONL persistence. All run-shaped logic lives here so tests
 * drive it directly without spawning a manager or an omp process.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentStatus, ReceiptRollup, RunReceipt } from "./types.ts";
import { shouldKeepSpans, SpanCollector, traceMaxSpans, traceSampleRatio } from "./spans.ts";
import { getStorageBackend } from "./dal/storage.ts";

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
	featureId?: string;
	parentId?: string;
	issue?: string;
	operator?: string;
	org?: string;
	/** Which harness drove the run; the daemon stamps "omp". */
	harness?: string;
	/** Confirmed-delivered efficiency flags (squad-manager's `confirmDeliveredFlags`, computed once at
	 *  spawn from `rec.efficiencyFlags`) — carried into the seed so a restarted-and-resumed run's
	 *  accumulator stamps the SAME confirmed set the whole run, not whatever is live on the record at
	 *  finish() time. */
	efficiencyFlags?: string[];
}

/** Marker prefix for `AgentProfile.capabilities` tokens that request a PROMPT-DELIVERED discipline
 *  (concern 05's `membrane:verdict-first` / `membrane:minimal-code`) rather than a real host-tool
 *  grant. `capabilities[]` is also the tool allow-list source (squad-manager.ts's `toolGrants`), so a
 *  membrane token left in that array would either wrongly narrow the grant or be denied as an
 *  unrecognized tool at the `onHostTool` gate — `splitCapabilityTokens` pulls it out before either
 *  happens. */
export const EFFICIENCY_FLAG_PREFIX = "membrane:";

/** Split a profile's raw `capabilities[]` into real tool grants and requested efficiency-flag tokens
 *  (`EFFICIENCY_FLAG_PREFIX`-prefixed). The ONLY site that turns `capabilities` into `toolGrants` —
 *  every downstream consumer (`toolGrantsPrompt`, the `onHostTool` hard-deny gate, the harness
 *  scorecard's `toolsScoped`) sees the filtered list, never a membrane token. */
export function splitCapabilityTokens(capabilities: string[] | undefined): { toolGrants: string[] | undefined; requested: string[] | undefined } {
	if (!capabilities?.length) return { toolGrants: undefined, requested: undefined };
	const tools = new Set<string>();
	const flags = new Set<string>();
	for (const token of capabilities) {
		if (token.startsWith(EFFICIENCY_FLAG_PREFIX)) flags.add(token);
		else tools.add(token);
	}
	return { toolGrants: tools.size ? [...tools] : undefined, requested: flags.size ? [...flags] : undefined };
}

/**
 * Delivery confirmation for requested efficiency-flag tokens. `--append-system-prompt` content only
 * reaches the child process when the resolved harness's `contextInjection` capability is `"native"`
 * (the omp/pi families) — ACP's default `"none"` silently drops the whole appended string
 * (`acp-agent-driver.ts`), so a request routed there was never delivered. Stamping at REQUEST time
 * (when the profile is merged) instead of here would measure a placebo, not a real behavior change —
 * the mistake this function exists to prevent (DESIGN.md "Membrane measurement").
 */
export function confirmDeliveredFlags(requested: string[] | undefined, contextInjection: "native" | "none" | "mcp" | undefined): string[] | undefined {
	if (!requested?.length) return undefined;
	return contextInjection === "native" ? requested : undefined;
}

/**
 * Per-unit flag identity across all its runs. `RunReceipt` is one line per run and a unit can restart,
 * so a single agentId can accumulate several receipts with independently-stamped `efficiencyFlags`.
 * When every run agrees exactly (the common case — same profile, same harness, every run), the
 * identity is that shared set. When runs disagree (a mid-flight profile edit, or a harness swap
 * between a native and an ACP-none run), returns `["mixed"]` instead of silently unioning a
 * confirmed-delivered run with a non-delivered one — a future flagSet-vs-baseline comparison (concern
 * 01's `task-class-matrix.ts`) can exclude `mixed` populations rather than reading their blended signal
 * as clean.
 */
export function unitEfficiencyFlags(receipts: RunReceipt[]): string[] {
	if (receipts.length === 0) return [];
	const canonical = (flags?: string[]) => [...new Set(flags ?? [])].sort().join(" ");
	const first = canonical(receipts[0].efficiencyFlags);
	const allAgree = receipts.every((r) => canonical(r.efficiencyFlags) === first);
	if (!allAgree) return ["mixed"];
	return [...new Set(receipts[0].efficiencyFlags ?? [])].sort();
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
	private readonly spans: SpanCollector;
	/** Set once finalizeRun has persisted this run; guards double-append. */
	finalized = false;

	constructor(seed: RunSeed) {
		this.seed = { ...seed };
		this.spans = new SpanCollector(this.seed);
	}

	/** The live run's trace id (same id-space `RunReceipt.traceId`/`/api/trace/:id` use — `feat:<featureId>`
	 *  or `run:<agentId>:<runId>` with THIS accumulator's own runId), or "" before `start()` first runs. */
	get traceId(): string {
		return this.spans.id;
	}

	/** Begin a run. Idempotent within a live run; refreshes model when given. */
	start(model?: string): void {
		if (model) this.seed.model = model;
		if (this.started) return;
		this.started = true;
		this.runId = Date.now().toString(36);
		this.startedAt = Date.now();
		this.spans.start(this.runId, this.startedAt, this.seed.model);
		this.toolCalls = 0;
		this.toolTally = {};
		this.tokens = undefined;
		this.costUsd = undefined;
		this.filesTouched = [];
		this.endedAt = undefined;
		this.durationMs = undefined;
	}

	onTool(toolName: string, intent = ""): void {
		this.toolCalls++;
		this.toolTally[toolName] = (this.toolTally[toolName] ?? 0) + 1;
		this.spans.onTool(toolName, intent);
	}

	/** Late-bind the effective model from the wire (e.g. an assistant frame's `message.model`).
	 *  First-model-wins: never overwrites an explicit `opts.model` seeded at `start()`, and only
	 *  ever sets once, since there is no mid-run model swap in v1. */
	noteModel(model: string): void {
		if (!this.seed.model && model) this.seed.model = model;
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

	onMessageEnd(): void {
		this.spans.onMessageEnd();
	}

	onSubagentFrame(frame: { type: string; payload?: unknown }): void {
		this.spans.onSubagentFrame(frame);
	}

	finish(status: AgentStatus, filesTouched: string[]): void {
		this.endedAt = Date.now();
		this.durationMs = this.endedAt - this.startedAt;
		this.status = status;
		this.filesTouched = filesTouched;
		this.spans.finish(status, this.endedAt);
	}

	/** Immutable copy of the current run state. */
	snapshot(opts: { includeSpans?: boolean; sampleRatio?: number; maxSpans?: number; random?: () => number } = {}): RunReceipt {
		// D1: sampling is per-layer, not per-run. `tools` is the vote on whether TOOL-level detail
		// survives; the structural spine (run/node/subagent) is never sampled and is always attached
		// below, so a finalized receipt is never `partial` for lack of spans.
		const tools =
			opts.includeSpans ??
			shouldKeepSpans(this.status, this.spans.hasError(), opts.sampleRatio ?? traceSampleRatio(), opts.random);
		const receipt: RunReceipt = {
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
			traceId: this.spans.id,
			featureId: this.seed.featureId,
			parentId: this.seed.parentId,
			harness: this.seed.harness ?? "omp",
			efficiencyFlags: this.seed.efficiencyFlags,
		};
		receipt.spans = tools ? this.spans.snapshot(opts.maxSpans ?? traceMaxSpans()) : this.spans.structuralSnapshot();
		receipt.sampled = !tools && this.spans.hasToolSpans();
		return receipt;
	}

	/** Compact summary for the DTO. */
	rollup(): ReceiptRollup {
		return { toolCalls: this.toolCalls, costUsd: this.costUsd, durationMs: this.durationMs, endedAt: this.endedAt, tokens: this.tokens?.total };
	}
}

/** A forwarded omp wire frame (only the fields receipts reads). */
type Frame = {
	type?: string;
	toolName?: string;
	message?: { role?: string; usage?: AssistantUsage; model?: string };
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
			acc.onTool(typeof frame.toolName === "string" ? frame.toolName : "tool", typeof frame.intent === "string" ? frame.intent : "");
			break;
		case "message_end":
			if (frame.message?.role === "assistant") {
				if (frame.message.usage) acc.onAssistantUsage(frame.message.usage);
				if (frame.message.model) acc.noteModel(frame.message.model);
			}
			acc.onMessageEnd();
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
	// Append + fsync through the active StorageBackend so a committed receipt line survives a host crash
	// and rides whatever substrate is configured. The read path (readReceipts) is per-line tolerant, so
	// fsync only narrows the torn-tail window.
	await getStorageBackend().appendDurable(receiptPath(baseDir, receipt.agentId), `${JSON.stringify(receipt)}\n`);
}

export async function readReceipts(baseDir: string, agentId: string): Promise<RunReceipt[]> {
	let text: string;
	try {
		text = await fs.readFile(receiptPath(baseDir, agentId), "utf8");
	} catch {
		return [];
	}
	// Per-line tolerant, as appendReceipt's fsync comment promises: a host crash can leave a torn tail
	// line (a half-written append). Skip anything unparseable rather than throwing — an uncaught throw
	// here 500s every receipts-backed endpoint (/api/usage, /api/heat, /api/activity, /api/trace,
	// /api/graph/attribution), none of which guards this call, on a single corrupt line.
	const out: RunReceipt[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as RunReceipt);
		} catch {
			// torn/corrupt line (crash mid-append) — drop it and keep the rest
		}
	}
	return out;
}


export async function readAllReceipts(baseDir: string): Promise<RunReceipt[]> {
	const dir = path.join(baseDir, "receipts");
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const out: RunReceipt[] = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		out.push(...(await readReceipts(baseDir, name.slice(0, -".jsonl".length))));
	}
	return out;
}