/**
 * claude-code ingest — external-harness receipts from Claude Code's own session
 * transcripts (~/.claude/projects/<encoded-cwd>/<session>.jsonl).
 *
 * The fleet-pulse harness attribution can only be as good as its ledger, and the
 * daemon only writes receipts for runs IT spawned. Claude Code sessions burn
 * tokens straight through Anthropic — so this module reads their transcripts and
 * appends equivalent RunReceipts (harness: "claude-code", cost = API-equivalent
 * from the rates table). One ledger, many harnesses.
 *
 * Idempotency: a cursor file records how many lines of each session were already
 * ingested. A session is only ingested once it has been idle for `idleMs`; if it
 * later grows (resumed session), only the NEW lines become a continuation
 * receipt. Parsing is pure; only the walk/cursor does IO.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendReceipt } from "../receipts.ts";
import type { RunReceipt } from "../types.ts";
import { estimateCost } from "../omp-graph/rates.ts";

export interface SessionSummary {
	sessionId: string;
	startedAt: number;
	endedAt: number;
	/** last seen cwd — sessions in worktrees normalize to the main repo. */
	cwd: string;
	branch?: string;
	/** dominant model by output tokens. */
	model?: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	costUsd: number;
	toolCalls: number;
	filesTouched: string[];
	lines: number;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A worktree cwd (`<repo>/.claude/worktrees/x`) attributes to the repo itself. */
export function normalizeRepo(cwd: string): string {
	const i = cwd.indexOf(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
	return i === -1 ? cwd : cwd.slice(0, i);
}

/** Summarize transcript lines [from..end). Pure. Returns null when nothing usable. */
export function parseSession(lines: string[], sessionIdHint = "", from = 0): SessionSummary | null {
	let sessionId = sessionIdHint;
	let startedAt = 0;
	let endedAt = 0;
	let cwd = "";
	let branch: string | undefined;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const byModelOut = new Map<string, number>();
	let costUsd = 0;
	let toolCalls = 0;
	const files = new Set<string>();

	for (let i = from; i < lines.length; i++) {
		const raw = lines[i];
		if (!raw.trim()) continue;
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			continue; // torn tail
		}
		if (typeof d.sessionId === "string" && !sessionId) sessionId = d.sessionId;
		if (typeof d.cwd === "string") cwd = d.cwd;
		if (typeof d.gitBranch === "string") branch = d.gitBranch;
		const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
		if (Number.isFinite(ts)) {
			if (!startedAt) startedAt = ts;
			if (ts > endedAt) endedAt = ts;
		}
		const msg = d.message as { model?: string; usage?: Record<string, number>; content?: unknown } | undefined;
		if (!msg) continue;
		if (Array.isArray(msg.content)) {
			for (const c of msg.content as { type?: string; name?: string; input?: { file_path?: string } }[]) {
				if (c?.type !== "tool_use") continue;
				toolCalls++;
				if (c.name && FILE_TOOLS.has(c.name) && typeof c.input?.file_path === "string") files.add(c.input.file_path);
			}
		}
		if (d.type === "assistant" && msg.usage) {
			const u = msg.usage;
			const block = {
				input: u.input_tokens ?? 0,
				output: u.output_tokens ?? 0,
				cacheRead: u.cache_read_input_tokens ?? 0,
				cacheWrite: u.cache_creation_input_tokens ?? 0,
			};
			tokens.input += block.input;
			tokens.output += block.output;
			tokens.cacheRead += block.cacheRead;
			tokens.cacheWrite += block.cacheWrite;
			costUsd += estimateCost(msg.model, block);
			if (msg.model) byModelOut.set(msg.model, (byModelOut.get(msg.model) ?? 0) + block.output);
		}
	}

	tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	if (!sessionId || !startedAt || tokens.total === 0) return null;
	const model = [...byModelOut.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	return {
		sessionId,
		startedAt,
		endedAt: endedAt || startedAt,
		cwd,
		branch,
		model,
		tokens,
		costUsd,
		toolCalls,
		filesTouched: [...files].slice(0, 200),
		lines: lines.length,
	};
}

/** A summary as a fleet receipt. Pure. */
export function sessionToReceipt(s: SessionSummary, opts: { continuation?: boolean } = {}): RunReceipt {
	const short = s.sessionId.slice(0, 8);
	return {
		agentId: `cc-${short}`,
		name: `claude-code ${short}${opts.continuation ? " (resumed)" : ""}`,
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
		tokens: { ...s.tokens },
		costUsd: s.costUsd,
		filesTouched: s.filesTouched,
		harness: "claude-code",
	};
}

/** Claude Code's project-dir encoding of an absolute path. */
export function encodeProjectDir(p: string): string {
	return p.replace(/[/\\.]/g, "-");
}

interface Cursor {
	[file: string]: { lines: number; size: number };
}

export interface IngestResult {
	scanned: number;
	ingested: number;
}

/**
 * Walk the repo's Claude Code project dirs (main + its worktrees), append
 * receipts for idle sessions not yet (fully) ingested. Cheap after the first
 * pass — the cursor skips unchanged files by size.
 */
export async function ingestClaudeCode(opts: {
	stateDir: string;
	repo: string;
	claudeProjectsDir?: string;
	idleMs?: number;
	now?: number;
}): Promise<IngestResult> {
	const now = opts.now ?? Date.now();
	const idleMs = opts.idleMs ?? 10 * 60_000;
	const base = opts.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
	const enc = encodeProjectDir(path.resolve(opts.repo));
	const cursorFile = path.join(opts.stateDir, "ingest", "claude-code.json");
	let cursor: Cursor = {};
	try {
		cursor = JSON.parse(await fs.readFile(cursorFile, "utf8")) as Cursor;
	} catch {
		// first run
	}

	let dirs: string[] = [];
	try {
		dirs = (await fs.readdir(base)).filter((d) => d === enc || d.startsWith(`${enc}--claude-worktrees`));
	} catch {
		return { scanned: 0, ingested: 0 };
	}

	let scanned = 0;
	let ingested = 0;
	for (const dir of dirs) {
		let entries: string[] = [];
		try {
			entries = (await fs.readdir(path.join(base, dir))).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of entries) {
			const full = path.join(base, dir, f);
			scanned++;
			let stat: { size: number; mtimeMs: number };
			try {
				stat = await fs.stat(full);
			} catch {
				continue;
			}
			const cur = cursor[full];
			if (cur && cur.size === stat.size) continue; // fully ingested, unchanged
			if (now - stat.mtimeMs < idleMs) continue; // still live — wait for idle
			let text: string;
			try {
				text = await fs.readFile(full, "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n");
			const from = cur?.lines ?? 0;
			const summary = parseSession(lines, f.replace(/\.jsonl$/, ""), from);
			cursor[full] = { lines: lines.length, size: stat.size };
			if (!summary) continue;
			// sessions that never worked in this repo (stray cwd) are skipped
			if (!normalizeRepo(summary.cwd).startsWith(path.resolve(opts.repo))) continue;
			await appendReceipt(opts.stateDir, sessionToReceipt(summary, { continuation: from > 0 }));
			ingested++;
		}
	}

	await fs.mkdir(path.dirname(cursorFile), { recursive: true });
	await fs.writeFile(cursorFile, JSON.stringify(cursor));
	return { scanned, ingested };
}

// ── lazy trigger for the server: at most one walk per THROTTLE_MS per repo ────
const THROTTLE_MS = 5 * 60_000;
const lastRun = new Map<string, number>();

export async function maybeIngestClaudeCode(stateDir: string, repo: string): Promise<void> {
	const key = `${stateDir}:${repo}`;
	const last = lastRun.get(key) ?? 0;
	if (Date.now() - last < THROTTLE_MS) return;
	lastRun.set(key, Date.now());
	try {
		const r = await ingestClaudeCode({ stateDir, repo });
		if (r.ingested > 0) console.log(`claude-code ingest: ${r.ingested} session(s) → receipts (${r.scanned} scanned)`);
	} catch (err) {
		console.warn("claude-code ingest failed:", err);
	}
}
