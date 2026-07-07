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
 *
 * Dedupe: Claude Code writes one jsonl line per assistant CONTENT BLOCK (thinking/
 * text/tool_use), not one per API response — every block of one response repeats the
 * same `message.usage`. `parseSession` dedupes by `message.id` so each response's
 * tokens/cost are billed once (naive per-line summing over-billed by ~2.35× on a real
 * transcript). See `CursorFileEntry.v` for how a cursor already-marked "done" under
 * the old math gets healed on upgrade.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getStorageBackend } from "../dal/storage.ts";
import { appendReceipt } from "../receipts.ts";
import type { RunReceipt } from "../types.ts";
import { estimateCost } from "../omp-graph/rates.ts";
import type { HarnessIngester } from "./harness.ts";

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

/**
 * True when a session `cwd` belongs to `repo` — the repo itself or a directory under it. Boundary-safe:
 * a bare `startsWith` matches a name-prefixed SIBLING (`myrepo-backup` under `myrepo`) and would ingest a
 * foreign repo's sessions into this repo's receipts (cross-repo contamination). Matches the `${root}${sep}`
 * discipline already used in dispatch.ts / features.ts / agent-guard.ts / worktree-reaper.ts.
 */
export function cwdBelongsToRepo(cwd: string, repo: string): boolean {
	const norm = normalizeRepo(cwd);
	const root = path.resolve(repo);
	return norm === root || norm.startsWith(root + path.sep);
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
	// Claude Code writes ONE jsonl line per assistant content block (thinking/text/tool_use), each
	// repeating the SAME `message.usage` for that single API response (same `message.id`). Summing
	// every line double- (or triple-, quadruple-…) counts tokens/cost. Dedupe by id so each API
	// response is billed exactly once; a line with no id (older transcript format) is always billed —
	// there's nothing to dedupe against.
	const seenMessageIds = new Set<string>();

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
		const msg = d.message as { id?: string; model?: string; usage?: Record<string, number>; content?: unknown } | undefined;
		if (!msg) continue;
		if (Array.isArray(msg.content)) {
			for (const c of msg.content as { type?: string; name?: string; input?: { file_path?: string } }[]) {
				if (c?.type !== "tool_use") continue;
				toolCalls++;
				if (c.name && FILE_TOOLS.has(c.name) && typeof c.input?.file_path === "string") files.add(c.input.file_path);
			}
		}
		if (d.type === "assistant" && msg.usage) {
			const msgId = typeof msg.id === "string" ? msg.id : undefined;
			const isDuplicate = msgId !== undefined && seenMessageIds.has(msgId);
			if (msgId !== undefined) seenMessageIds.add(msgId);
			if (!isDuplicate) {
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

interface CursorFileEntry {
	lines: number;
	size: number;
	/**
	 * Cursor-entry schema version this file was last (re)ingested under. Bump
	 * `CURSOR_SCHEMA_VERSION` whenever a fix changes how `parseSession` computes totals from
	 * an UNCHANGED transcript (e.g. the message.id dedupe below) — otherwise a file the OLD
	 * code already marked "fully ingested" (size matches) skips forever and its stale receipt
	 * (e.g. ~2.35× inflated pre-dedupe) survives the fix undetected. An entry stamped with an
	 * older version bypasses the unchanged-skip once: its previously-appended receipt is
	 * purged and the file is fully re-parsed under the current logic, so the correction lands
	 * as a single clean receipt rather than summed on top of the stale one. Absent ⇒ 0
	 * (pre-versioning cursor, e.g. any real cursor written before this field existed).
	 */
	v?: number;
}
type Cursor = Record<string, CursorFileEntry>;

/** Bump on any fix to `parseSession`'s totals math (see `CursorFileEntry.v`). */
const CURSOR_SCHEMA_VERSION = 1;

/** Delete a session's previously-appended receipt file, if any — used only when migrating a
 *  stale (pre-`CURSOR_SCHEMA_VERSION`) cursor entry so the corrected recompute isn't summed
 *  on top of the old, wrong totals. Silently a no-op if nothing was ever ingested for it. */
async function purgeStaleReceipt(stateDir: string, sessionIdHint: string): Promise<void> {
	try {
		await fs.unlink(receiptPathFor(stateDir, sessionIdHint));
	} catch {
		// nothing to purge
	}
}

function receiptPathFor(stateDir: string, sessionIdHint: string): string {
	return path.join(stateDir, "receipts", `cc-${sessionIdHint.slice(0, 8)}.jsonl`);
}

export interface IngestResult {
	scanned: number;
	ingested: number;
}

/**
 * Walk the repo's Claude Code project dirs (main + its worktrees), append
 * receipts for idle sessions not yet (fully) ingested. Cheap after the first
 * pass — the cursor skips unchanged files by size (unless stale, see `CursorFileEntry.v`).
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
	const cursorRaw = await getStorageBackend().readText(cursorFile);
	if (cursorRaw !== undefined) {
		try {
			cursor = JSON.parse(cursorRaw) as Cursor;
		} catch {
			// corrupt — first run
		}
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
			const stale = !!cur && (cur.v ?? 0) < CURSOR_SCHEMA_VERSION;
			if (cur && cur.size === stat.size && !stale) continue; // fully ingested, unchanged, current schema
			if (now - stat.mtimeMs < idleMs) continue; // still live — wait for idle
			let text: string;
			try {
				text = await fs.readFile(full, "utf8");
			} catch {
				continue;
			}
			const sessionIdHint = f.replace(/\.jsonl$/, "");
			if (stale) {
				// a pre-CURSOR_SCHEMA_VERSION ingest already appended a receipt computed under
				// the OLD (buggy) math — purge it before recomputing so the fix doesn't sum the
				// corrected total on top of the stale one.
				await purgeStaleReceipt(opts.stateDir, sessionIdHint);
			}
			const lines = text.split("\n");
			const from = stale ? 0 : (cur?.lines ?? 0); // stale ⇒ full clean recompute, not a delta continuation
			const summary = parseSession(lines, sessionIdHint, from);
			cursor[full] = { lines: lines.length, size: stat.size, v: CURSOR_SCHEMA_VERSION };
			if (!summary) continue;
			// sessions that never worked in this repo (stray cwd) are skipped
			if (!cwdBelongsToRepo(summary.cwd, opts.repo)) continue;
			await appendReceipt(opts.stateDir, sessionToReceipt(summary, { continuation: from > 0 }));
			ingested++;
		}
	}

	await getStorageBackend().writeDurable(cursorFile, JSON.stringify(cursor));
	return { scanned, ingested };
}

/** Registered in the harness-ingest framework (src/ingest/harness.ts); throttling + failure
 *  isolation now live in the shared `ingestAllHarnesses`. */
export const claudeCodeIngester: HarnessIngester = {
	name: "claude-code",
	ingest: (o) => ingestClaudeCode(o),
};
