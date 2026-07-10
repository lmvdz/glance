/**
 * Lossless gate-log offload (plans/eap-borrows/ concern 03, "validator half").
 *
 * The validator judge is a one-shot, tool-less LLM call — it can only see what fits in its
 * prompt, so oversized diffs/proof output used to be silently head-truncated (`truncate()` in
 * validator.ts). That drops evidence a human investigating a veto/pass can never recover. This
 * module keeps the FULL text durable on disk (one plain log file per write, path = pointer) and
 * hands the judge a deterministic, budget-bounded excerpt instead, with a pointer line back to
 * the full file.
 *
 * Storage shape: `<stateDir>/gate-logs/<agentId>/<ts>-<nonce>-<kind>.log`. `<nonce>` (not just the
 * millisecond timestamp) is load-bearing — the criteria judge and up to `OMP_SQUAD_LENS_MAX` lens
 * judges can all excerpt the SAME oversized diff within the same synchronous tick (Promise.allSettled
 * in `runLensPanel`); a ts-only path would let two writers race the same `<path>.tmp` (the torn-write
 * bug DESIGN.md's "Offload store" decision explicitly cut CAS to avoid). A unique path per write means
 * every writer owns its own tmp file — no rename ever races another rename.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import { resolveStateDir } from "./state-dir.ts";

let gateLogRoot = path.join(resolveStateDir(), "gate-logs");

/** Manager/org state root owns gate-log storage (mirrors `setProofRoot`); tests use the default. */
export function setGateLogRoot(stateDir: string): void {
	gateLogRoot = path.join(stateDir, "gate-logs");
}

/** Filesystem-safe path segment — an agentId/kind can in principle carry anything; this keeps the
 *  on-disk layout inside `gateLogRoot` regardless of what a caller passes. */
function safeSegment(s: string, fallback: string): string {
	const cleaned = s.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return cleaned.length > 0 ? cleaned : fallback;
}

/** Durably persist the FULL `content` for one agent's gate-log stream. Returns the pointer path and
 *  byte size. Unique path per call — see module doc; never reused, never appended to. */
export async function writeGateLog(agentId: string, kind: string, content: string): Promise<{ path: string; bytes: number }> {
	const ts = Date.now();
	const nonce = randomBytes(4).toString("hex");
	const dir = path.join(gateLogRoot, safeSegment(agentId, "unknown"));
	const file = path.join(dir, `${ts}-${nonce}-${safeSegment(kind, "log")}.log`);
	await getStorageBackend().writeDurable(file, content);
	return { path: file, bytes: Buffer.byteLength(content, "utf8") };
}

/** Gate logs older than this are for a long-landed/abandoned unit — swept so per-agent dirs don't
 *  pile up forever. Mirrors proof.ts's `PROOF_TTL_MS` cadence style at a longer horizon (these are
 *  forensic evidence, not a freshness gate, so a wider default is safe). */
const GATE_LOG_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Remove gate-log files older than `maxAgeMs` and any now-empty agent dirs. Age is read from the
 * write timestamp EMBEDDED in the filename (`<ts>-<nonce>-<kind>.log`), not a real `fs.stat` mtime —
 * the `StorageBackend` seam (src/dal/storage.ts) deliberately exposes no stat() method, and content
 * here is plain text (not JSON like proof.ts's `ranAt`), so the filename is the one place a
 * cross-backend-safe timestamp lives. A file whose name doesn't parse as `<ts>-...` is treated as
 * unaged (kept) rather than guessed at. Returns the count removed.
 */
export async function sweepGateLogs(maxAgeMs = GATE_LOG_TTL_MS): Promise<number> {
	const storage = getStorageBackend();
	const agentDirs = await storage.readdir(gateLogRoot); // [] when the root doesn't exist
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const agentDir of agentDirs) {
		const dir = path.join(gateLogRoot, agentDir);
		const files = await storage.readdir(dir); // [] when missing → nothing to sweep
		let live = 0;
		for (const f of files) {
			if (!f.endsWith(".log")) continue;
			const ts = Number.parseInt(f.split("-")[0] ?? "", 10);
			if (Number.isFinite(ts) && ts < cutoff) {
				await storage.remove(path.join(dir, f));
				removed++;
			} else {
				live++;
			}
		}
		if (live === 0) await storage.remove(dir).catch(() => {});
	}
	return removed;
}

/** What to excerpt: `"diff"` gets diffstat + whole-hunk packing; `"log"` (proof tails, suite output)
 *  gets head+tail (conclusions live in tails). */
export interface BudgetedExcerptMeta {
	kind: "diff" | "log";
	/** Owning agent for the offload file's directory; falls back to "unknown" when absent so an
	 *  oversized artifact is still persisted somewhere findable rather than silently dropped. */
	agentId?: string;
}

export interface BudgetedExcerpt {
	/** The excerpt to hand the judge — always `<= budget` chars except for the small fixed pointer
	 *  line appended on an oversized input. */
	text: string;
	/** Set only when `s` exceeded `budget` AND the full content was durably persisted. */
	path?: string;
}

/** One file-diff's worth of `diff --git ...` text, including its header lines up to the first hunk. */
function splitDiffFiles(diff: string): string[] {
	const lines = diff.split("\n");
	const files: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (line.startsWith("diff --git ") && current.length > 0) {
			files.push(current.join("\n"));
			current = [line];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) files.push(current.join("\n"));
	return files;
}

/** Split one file's diff text into its non-hunk header and its `@@ ... @@` hunk bodies. */
function splitFileHunks(fileDiff: string): { header: string; hunks: string[] } {
	const lines = fileDiff.split("\n");
	const header: string[] = [];
	const hunks: string[] = [];
	let current: string[] | undefined;
	for (const line of lines) {
		if (line.startsWith("@@ ")) {
			if (current) hunks.push(current.join("\n"));
			current = [line];
		} else if (current) {
			current.push(line);
		} else {
			header.push(line);
		}
	}
	if (current) hunks.push(current.join("\n"));
	return { header: header.join("\n"), hunks };
}

/** Crude but dependency-free diffstat over the FULL diff (never the packed portion — the header must
 *  stay honest about everything that was omitted, not just what made it into the excerpt). */
function diffStat(diff: string): string {
	let files = 0;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) files++;
		else if (line.startsWith("+++") || line.startsWith("---")) continue;
		else if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return `${files} file${files === 1 ? "" : "s"} changed, +${added}/-${removed} lines`;
}

/**
 * Greedily pack WHOLE file-diffs (and, for a file too big to fit whole, WHOLE hunks within it) into
 * `budget` chars. Never bisects a hunk — a split hunk shows phantom deletions to a regression-hunting
 * lens (DESIGN.md "Judge excerpting"). Stops at the first file/hunk that would overflow the budget.
 */
function packDiffToBudget(diff: string, budget: number): string {
	if (budget <= 0) return "";
	const files = splitDiffFiles(diff);
	const out: string[] = [];
	let used = 0;
	for (const file of files) {
		const sep = out.length > 0 ? 1 : 0;
		if (used + sep + file.length <= budget) {
			out.push(file);
			used += sep + file.length;
			continue;
		}
		// This file alone doesn't fit whole — pack whole hunks within it instead of skipping it entirely.
		const remaining = budget - used - sep;
		const { header, hunks } = splitFileHunks(file);
		if (remaining > header.length) {
			const pieces = [header];
			let hused = header.length;
			for (const hunk of hunks) {
				if (hused + 1 + hunk.length > remaining) break; // never bisect a hunk
				pieces.push(hunk);
				hused += 1 + hunk.length;
			}
			if (pieces.length > 1) out.push(pieces.join("\n"));
		}
		break; // budget exhausted — later files are represented only in the diffstat header
	}
	return out.join("\n");
}

/** head 0.5 + tail 0.5 — conclusions (pass/fail summary) live in tails, so a pure head-truncate used
 *  to cut exactly the part a reviewer needs most. */
function headTail(s: string, budget: number): string {
	if (budget <= 0) return "";
	const sep = "\n…\n";
	const usable = Math.max(0, budget - sep.length);
	const headLen = Math.ceil(usable / 2);
	const tailLen = usable - headLen;
	const head = s.slice(0, headLen);
	const tail = tailLen > 0 ? s.slice(s.length - tailLen) : "";
	return `${head}${sep}${tail}`;
}

/**
 * Budget `s` to `budget` chars for a judge prompt. `s.length <= budget` returns it untouched and
 * writes nothing (the common case — no offload cost for small diffs). Oversized input is excerpted
 * (diff-aware for `kind:"diff"`, head+tail otherwise), the FULL original is durably persisted via
 * `writeGateLog`, and a `[N bytes omitted — full: <path>]` pointer is appended.
 *
 * NEVER throws: any write failure (disk full, storage backend down) is caught and this degrades to a
 * plain truncate with no pointer/file — a throw here would fail-CLOSE a land (validator.ts's judges
 * are all never-throw by contract; see judgeUserPrompt/lensUserPrompt callers).
 */
export async function budgetedExcerpt(s: string, budget: number, meta: BudgetedExcerptMeta): Promise<BudgetedExcerpt> {
	if (s.length <= budget) return { text: s };
	try {
		const body = meta.kind === "diff" ? (() => {
			const stat = `diffstat: ${diffStat(s)}\n\n`;
			return `${stat}${packDiffToBudget(s, Math.max(0, budget - stat.length))}`;
		})() : headTail(s, budget);
		const { path: full } = await writeGateLog(meta.agentId ?? "unknown", meta.kind, s);
		const omitted = Math.max(0, s.length - body.length);
		return { text: `${body}\n[${omitted} bytes omitted — full: ${full}]`, path: full };
	} catch (err) {
		console.error(`[gate-logs] offload write failed, falling back to plain truncate: ${err instanceof Error ? err.message : String(err)}`);
		return { text: `${s.slice(0, budget)}…` };
	}
}
