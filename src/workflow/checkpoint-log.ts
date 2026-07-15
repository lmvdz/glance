/**
 * Append-only per-run checkpoint log (mirrors receipts.ts's JSONL convention): one line per node-
 * boundary checkpoint under `stateDir/workflow-checkpoints/<runId>.jsonl`. Fed from squad-manager's
 * existing `a.on("checkpoint", ...)` listener, excluding the engine's transient per-branch fan-out
 * emissions (see EngineCheckpoint.transient) — those are live-progress noise, not resumable history.
 *
 * `seq` is a per-runId serialized append counter (mirrors squad-manager.ts's `writeChain`
 * promise-chaining, scoped per runId instead of globally), initialized from the file's existing line
 * count on the first append after a process boot so it stays unique and monotonic across daemon
 * restarts of the same run without any persisted counter of its own. The read path is per-line
 * tolerant of a torn trailing line (a hard crash mid-append never poisons the whole log).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { headTail } from "../gate-logs.ts";
import { classifyAndReduce } from "../output-reduce.ts";
import { redact } from "../redact.ts";
import type { WorkflowRunState } from "./types.ts";

/** Projection of the full logged WorkflowRunState shown to the fork-step picker (never `vars`). */
export interface CheckpointLogEntry {
	seq: number;
	at: number;
	currentNode: string;
	outcome?: "succeeded" | "failed";
	headSha?: string;
	vars?: Record<string, string>;
}

/** One full log line as written: the run state at that boundary, plus log bookkeeping. */
export type CheckpointLogLine = WorkflowRunState & { headSha?: string; seq: number; at: number };

const MAX_FIELD_BYTES = 4096;

export function checkpointLogPath(stateDir: string, runId: string): string {
	return path.join(stateDir, "workflow-checkpoints", `${runId}.jsonl`);
}

/** Per-runId append state: the next seq to assign, and the promise chain serializing writes. */
const chains = new Map<string, { seq: number; chain: Promise<void> }>();

/**
 * Count PARSEABLE, newline-terminated lines, repairing a torn trailing line on disk (review finding 7): a
 * crash mid-append leaves a partial line with NO trailing newline. The naive `text.trim().split("\n").length`
 * this used to do counts that torn fragment as a whole line — so the next `appendFile` glues its own write
 * directly onto the fragment's tail (no separating newline), producing ONE unparseable merged line that
 * `readCheckpoints` can only skip whole. That's a permanent seq hole: BOTH the torn entry AND the next
 * (fully-written) one are lost from every future read, and a `forkPoint.seq` referencing either becomes
 * un-forkable. Fixing this requires repairing the file the FIRST time this runId's log is touched after a
 * boot (`chainFor`'s init) — before any append can glue onto it — so `seq` always equals the number of
 * complete, parseable lines and a torn fragment can never merge with a subsequent write.
 */
async function repairAndCountLines(file: string): Promise<number> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch {
		return 0; // ENOENT (or any read failure) ⇒ nothing appended yet this process/host.
	}
	if (!text) return 0;
	// split("\n") on a file written exclusively via `appendFile(..., json + "\n")` always ends in one of two
	// ways: a clean file's last element is "" (the byte after the final "\n"); a torn file's last element is
	// the unterminated partial write itself. Every OTHER element was followed by a real "\n" in the original
	// text, so it's a candidate complete line regardless of which case this is.
	const rawLines = text.split("\n");
	const tail = rawLines[rawLines.length - 1] ?? "";
	const candidateLines = rawLines.slice(0, -1).filter((l) => l.trim());
	let complete = 0;
	for (const line of candidateLines) {
		try {
			JSON.parse(line);
			complete++;
		} catch {
			// A malformed COMPLETE (newline-terminated) line shouldn't normally happen — stay consistent with
			// readCheckpoints' own tolerance: skip, don't count, don't throw.
		}
	}
	if (tail.trim()) {
		// Torn trailing line — repair ON DISK now, before any append() can ever glue onto it. Truncates the
		// file to just its complete, newline-terminated lines.
		await fs.writeFile(file, complete > 0 ? candidateLines.join("\n") + "\n" : "");
	}
	return complete;
}

/** Reserve (or reuse) this runId's chain entry SYNCHRONOUSLY — no `await` before `chains.set` — so N
 *  concurrent `appendCheckpoint` calls for the same runId in the same tick all observe the one entry this
 *  function creates, instead of each racing `repairAndCountLines` independently and all starting at seq 0.
 *  `repairAndCountLines` runs exactly once here, on this runId's FIRST touch after a process boot — the
 *  only point a torn trailing line (from a crash mid-append before this boot) could otherwise be glued
 *  onto by the very first append below. */
function chainFor(runId: string, file: string): { seq: number; chain: Promise<void> } {
	let entry = chains.get(runId);
	if (!entry) {
		entry = { seq: 0, chain: Promise.resolve() };
		chains.set(runId, entry);
		entry.chain = repairAndCountLines(file).then((n) => {
			entry!.seq = n;
		});
	}
	return entry;
}

/**
 * Append one checkpoint line for `runId`, serialized per-runId so concurrent emissions never interleave
 * or race the seq counter. `state.vars.lastOutput`/`lastText` are redacted and bounded to `MAX_FIELD_BYTES`
 * before serializing — a long-running fix-up loop otherwise appends hundreds of multi-KB gate outputs per
 * run, and the checkpoint log is persisted to disk raw (unlike the compaction/gate-log stores, which
 * redact at their own boundary) so redaction has to happen HERE, not upstream.
 *
 * The two fields get different treatment because they're different KINDS of text (noisegate-compaction
 * concern 04, DESIGN.md "Budget headroom"/"Marker integrity"):
 *  - `lastOutput` is raw command output — already offloaded and signal-reduced once, upstream, by the
 *    executor's `reduceOutput` call (STEER_BODY_BUDGET headroom keeps that result ≤ ~3870 chars, safely
 *    under this field's 4096 cap, so the common case is a same-length pass-through). `classifyAndReduce`
 *    (the SYNC core only — no `reduceOutput`/offload here, since a second offload would durably write the
 *    same content twice) is still run so the rare over-cap value (a caller that never went through the
 *    executor, or a future widened budget) gets the SAME signal-ranked re-cut instead of a blind slice —
 *    and because the reducer's CRITICAL tier includes the offload pointer/marker grammar (raw AND its
 *    `> `-neutralized form), a pointer line from the upstream reduction survives any real re-reduction
 *    here rather than being amputated.
 *  - `lastText` is agent-authored PROSE (a fixup agent's own commentary), not command output — running it
 *    through `classifyAndReduce` would let a quoted `error TS2304:` line inside a sentence get treated as
 *    diagnostics signal and reorder/displace prose around it. `headTail` (plain head+tail, no shape
 *    classification) is the correct tool: conclusions in prose tend to live at both ends anyway, and it
 *    never misreads a quote as a failure.
 *  - Both are redacted BEFORE the size check/cut, not after: `redact()` can lengthen text slightly (a
 *    secret substring becomes `[REDACTED]`), so redact-then-cut is the only order that guarantees the
 *    PERSISTED field is both fully redacted and within budget. Redaction is scoped to exactly these two
 *    fields (documented scope claim, DESIGN.md) — every other `vars` entry persists raw, unchanged.
 */
export async function appendCheckpoint(stateDir: string, runId: string, state: WorkflowRunState & { headSha?: string }): Promise<void> {
	const file = checkpointLogPath(stateDir, runId);
	const entry = chainFor(runId, file);
	const run = entry.chain.then(async () => {
		const vars = state.vars ? { ...state.vars } : state.vars;
		if (vars?.lastOutput !== undefined) {
			vars.lastOutput = classifyAndReduce(redact(vars.lastOutput), MAX_FIELD_BYTES, { command: undefined }).text;
		}
		if (vars?.lastText !== undefined) {
			const r = redact(vars.lastText);
			vars.lastText = r.length <= MAX_FIELD_BYTES ? r : headTail(r, MAX_FIELD_BYTES);
		}
		const seq = entry.seq;
		const line: CheckpointLogLine = { ...state, vars, seq, at: Date.now() };
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.appendFile(file, JSON.stringify(line) + "\n");
		entry.seq = seq + 1; // only advance after a successful append
	});
	entry.chain = run.catch(() => {});
	await run;
}

/** The next seq that will be assigned to `runId` (i.e. how many entries have been durably appended so
 *  far). Read-only convenience for callers (e.g. the workflow_terminal handler) that need to reference
 *  "the checkpoint entry just appended" without racing appendCheckpoint's own promise chain — call this
 *  AFTER awaiting the appendCheckpoint() call for the same emission. */
export async function getLastSeq(stateDir: string, runId: string): Promise<number> {
	const entry = chains.get(runId);
	if (entry) {
		await entry.chain.catch(() => {}); // let any in-flight init/append settle before reading seq
		return entry.seq;
	}
	return repairAndCountLines(checkpointLogPath(stateDir, runId));
}

/** Read every well-formed entry, sorted by seq ascending. Tolerates a torn trailing line (partial JSON
 *  from a crash mid-append) by skipping it rather than throwing. */
export async function readCheckpoints(stateDir: string, runId: string): Promise<CheckpointLogLine[]> {
	let text: string;
	try {
		text = await fs.readFile(checkpointLogPath(stateDir, runId), "utf8");
	} catch {
		return [];
	}
	const out: CheckpointLogLine[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as CheckpointLogLine);
		} catch {
			// Torn trailing line from a hard crash mid-append — skip, don't throw.
		}
	}
	out.sort((a, b) => a.seq - b.seq);
	return out;
}

/** Best-effort delete of a run's checkpoint log, called from `remove(id, deleteWorktree: true)`. */
export async function deleteCheckpointLog(stateDir: string, runId: string): Promise<void> {
	chains.delete(runId);
	await fs.rm(checkpointLogPath(stateDir, runId), { force: true }).catch(() => {});
}

/** Drop this runId's in-memory append-chain bookkeeping WITHOUT touching the on-disk log — call once a
 *  run reaches a final state (workflow_done or workflow_terminal, after its last append has settled) so
 *  a long-lived daemon's `chains` map doesn't grow by one entry for the rest of the process's life for
 *  every run that finishes or escalates without ever being removed. Safe unconditionally: a stray
 *  post-final appendCheckpoint call for this runId (there should be none) just re-inits its seq from the
 *  file's existing line count, exactly like a fresh process boot would (see `chainFor`). */
export function evictCheckpointChain(runId: string): void {
	chains.delete(runId);
}
