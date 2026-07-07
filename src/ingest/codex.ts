/**
 * codex ingest — external-harness receipts from the OpenAI Codex CLI's own session
 * rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 *
 * Sibling to claude-code.ts: the fleet-pulse harness attribution is only as complete
 * as its ledger, and the daemon writes receipts only for runs IT spawned. Codex work
 * (`codex exec` / `codex review`, gpt-5.5 through OpenAI) burns tokens outside the
 * daemon entirely, so this reads its rollouts and appends equivalent RunReceipts
 * (harness: "codex", cost = API-equivalent from the rates table). One ledger, many
 * harnesses.
 *
 * Two accounting subtleties Codex's format forces (and Claude Code does not):
 *  - `token_count` events report the session's CUMULATIVE `total_token_usage`, not
 *    per-message deltas — so we take the running total and bill only the DELTA vs
 *    what a prior ingest already receipted (stored in the cursor). Summing the events
 *    would over-count by orders of magnitude.
 *  - `input_tokens` is INCLUSIVE of `cached_input_tokens`; cached input bills at 10%,
 *    so we split fresh input = input − cached and pass cached as cacheRead, else the
 *    cached portion is double-billed at the full input rate.
 *
 * Idempotency: a cursor records each rollout's byte size AND the cumulative usage
 * already receipted; a grown (resumed) file only bills the new delta. Parsing is pure;
 * only the walk/cursor does IO.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getStorageBackend } from "../dal/storage.ts";
import { appendReceipt } from "../receipts.ts";
import type { RunReceipt } from "../types.ts";
import { estimateCost } from "../omp-graph/rates.ts";
import { cwdBelongsToRepo, normalizeRepo } from "./claude-code.ts";
import type { HarnessIngester } from "./harness.ts";

/** Cumulative token usage as Codex reports it (input inclusive of cached). */
export interface CodexUsage {
	input: number;
	cachedInput: number;
	output: number;
	total: number;
}

export interface CodexSummary {
	sessionId: string;
	startedAt: number;
	endedAt: number;
	cwd: string;
	branch?: string;
	/** last model seen in a turn_context (e.g. "gpt-5.5"). */
	model?: string;
	/** CUMULATIVE usage from the final token_count event. */
	usage: CodexUsage;
	toolCalls: number;
	filesTouched: string[];
	lines: number;
}

const ZERO: CodexUsage = { input: 0, cachedInput: 0, output: 0, total: 0 };
const TOOL_END = new Set(["patch_apply_end", "web_search_end", "exec_command_end"]);

/** Files from a `patch_apply_end` stdout block ("A path" / "M path" / "D path"). */
function filesFromPatch(stdout: unknown, into: Set<string>): void {
	if (typeof stdout !== "string") return;
	for (const line of stdout.split("\n")) {
		const m = /^\s*[AMD]\s+(.+?)\s*$/.exec(line);
		if (m) into.add(m[1]);
	}
}

/** Summarize a whole rollout file's lines. Pure. Returns null when nothing usable. */
export function parseCodexRollout(lines: string[], sessionIdHint = ""): CodexSummary | null {
	let sessionId = sessionIdHint;
	let startedAt = 0;
	let endedAt = 0;
	let cwd = "";
	let branch: string | undefined;
	let model: string | undefined;
	let usage: CodexUsage = { ...ZERO };
	let toolCalls = 0;
	const files = new Set<string>();

	for (const raw of lines) {
		if (!raw.trim()) continue;
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			continue; // torn tail
		}
		const type = d.type;
		const payload = (d.payload ?? {}) as Record<string, unknown>;
		const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
		if (Number.isFinite(ts)) {
			if (!startedAt) startedAt = ts;
			if (ts > endedAt) endedAt = ts;
		}

		if (type === "session_meta") {
			if (typeof payload.session_id === "string") sessionId ||= payload.session_id;
			if (typeof payload.cwd === "string") cwd = payload.cwd;
			const git = payload.git as { branch?: string } | undefined;
			if (git && typeof git.branch === "string") branch = git.branch;
			const metaTs = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
			if (Number.isFinite(metaTs)) startedAt = startedAt ? Math.min(startedAt, metaTs) : metaTs;
		} else if (type === "turn_context") {
			if (typeof payload.model === "string") model = payload.model; // last wins
		} else if (type === "event_msg") {
			const sub = payload.type;
			if (typeof sub === "string" && TOOL_END.has(sub)) {
				toolCalls++;
				if (sub === "patch_apply_end") filesFromPatch(payload.stdout, files);
			}
			if (sub === "token_count") {
				const info = payload.info as { total_token_usage?: Record<string, number> } | undefined;
				const t = info?.total_token_usage;
				if (t) {
					// cumulative — LATEST wins, never summed.
					usage = {
						input: t.input_tokens ?? 0,
						cachedInput: t.cached_input_tokens ?? 0,
						output: t.output_tokens ?? 0,
						total: t.total_tokens ?? 0,
					};
				}
			}
		}
	}

	if (!sessionId || !startedAt || usage.total === 0) return null;
	return { sessionId, startedAt, endedAt: endedAt || startedAt, cwd, branch, model, usage, toolCalls, filesTouched: [...files].slice(0, 200), lines: lines.length };
}

/** API-equivalent cost of a usage DELTA — fresh input billed full, cached input at 10%. */
export function costOfDelta(model: string | undefined, delta: CodexUsage): number {
	const freshInput = Math.max(0, delta.input - delta.cachedInput);
	return estimateCost(model, { input: freshInput, output: delta.output, cacheRead: delta.cachedInput, cacheWrite: 0 });
}

/** Field-wise `a − b`, floored at 0 (a resumed file only bills what's new). */
function usageDelta(a: CodexUsage, b: CodexUsage): CodexUsage {
	return {
		input: Math.max(0, a.input - b.input),
		cachedInput: Math.max(0, a.cachedInput - b.cachedInput),
		output: Math.max(0, a.output - b.output),
		total: Math.max(0, a.total - b.total),
	};
}

/** A summary + its billable delta as a fleet receipt. Pure. */
export function summaryToReceipt(s: CodexSummary, delta: CodexUsage, opts: { continuation?: boolean } = {}): RunReceipt {
	const short = s.sessionId.slice(0, 8);
	const freshInput = Math.max(0, delta.input - delta.cachedInput);
	return {
		agentId: `codex-${short}`,
		name: `codex ${short}${opts.continuation ? " (resumed)" : ""}`,
		repo: normalizeRepo(s.cwd),
		branch: s.branch,
		model: s.model,
		runId: `${short}.${s.lines}`,
		startedAt: s.startedAt,
		endedAt: s.endedAt,
		durationMs: s.endedAt - s.startedAt,
		status: "stopped",
		toolCalls: s.toolCalls,
		toolTally: {},
		tokens: { input: freshInput, output: delta.output, cacheRead: delta.cachedInput, cacheWrite: 0, total: delta.total },
		costUsd: costOfDelta(s.model, delta),
		filesTouched: s.filesTouched,
		harness: "codex",
	};
}

interface CursorEntry {
	size: number;
	usage: CodexUsage;
}
interface Cursor {
	[file: string]: CursorEntry;
}

export interface IngestResult {
	scanned: number;
	ingested: number;
}

/**
 * Walk `~/.codex/sessions/**` for rollouts, append a receipt for the NEW usage of any
 * idle rollout whose cwd belongs to `repo`. Cheap after the first pass — the cursor
 * skips unchanged files by size.
 */
export async function ingestCodex(opts: { stateDir: string; repo: string; codexSessionsDir?: string; idleMs?: number; now?: number }): Promise<IngestResult> {
	const now = opts.now ?? Date.now();
	const idleMs = opts.idleMs ?? 10 * 60_000;
	const base = opts.codexSessionsDir ?? path.join(os.homedir(), ".codex", "sessions");
	const cursorFile = path.join(opts.stateDir, "ingest", "codex.json");
	let cursor: Cursor = {};
	const cursorRaw = await getStorageBackend().readText(cursorFile);
	if (cursorRaw !== undefined) {
		try {
			cursor = JSON.parse(cursorRaw) as Cursor;
		} catch {
			// corrupt — first run
		}
	}

	let rel: string[] = [];
	try {
		rel = (await fs.readdir(base, { recursive: true })) as string[];
	} catch {
		return { scanned: 0, ingested: 0 };
	}
	const rollouts = rel.filter((r) => {
		const b = path.basename(r);
		return b.startsWith("rollout-") && b.endsWith(".jsonl");
	});

	let scanned = 0;
	let ingested = 0;
	for (const r of rollouts) {
		const full = path.join(base, r);
		scanned++;
		let stat: { size: number; mtimeMs: number };
		try {
			stat = await fs.stat(full);
		} catch {
			continue;
		}
		const cur = cursor[full];
		if (cur && cur.size === stat.size) continue; // unchanged
		if (now - stat.mtimeMs < idleMs) continue; // still live — wait for idle
		let text: string;
		try {
			text = await fs.readFile(full, "utf8");
		} catch {
			continue;
		}
		const idHint = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(path.basename(full))?.[1] ?? "";
		const summary = parseCodexRollout(text.split("\n"), idHint);
		const prevUsage = cur?.usage ?? { ...ZERO };
		if (!summary) {
			cursor[full] = { size: stat.size, usage: prevUsage };
			continue;
		}
		if (!cwdBelongsToRepo(summary.cwd, opts.repo)) {
			cursor[full] = { size: stat.size, usage: summary.usage };
			continue;
		}
		const delta = usageDelta(summary.usage, prevUsage);
		cursor[full] = { size: stat.size, usage: summary.usage };
		if (delta.total <= 0) continue; // nothing new to bill
		await appendReceipt(opts.stateDir, summaryToReceipt(summary, delta, { continuation: prevUsage.total > 0 }));
		ingested++;
	}

	await getStorageBackend().writeDurable(cursorFile, JSON.stringify(cursor));
	return { scanned, ingested };
}

/** Registered in the harness-ingest framework (src/ingest/harness.ts); throttling + failure
 *  isolation now live in the shared `ingestAllHarnesses`. */
export const codexIngester: HarnessIngester = {
	name: "codex",
	ingest: (o) => ingestCodex(o),
};
