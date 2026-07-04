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
const TRUNCATED_SUFFIX = "…(truncated)";

export function checkpointLogPath(stateDir: string, runId: string): string {
	return path.join(stateDir, "workflow-checkpoints", `${runId}.jsonl`);
}

/** Per-runId append state: the next seq to assign, and the promise chain serializing writes. */
const chains = new Map<string, { seq: number; chain: Promise<void> }>();

async function lineCount(file: string): Promise<number> {
	try {
		const text = await fs.readFile(file, "utf8");
		const trimmed = text.trim();
		return trimmed ? trimmed.split("\n").length : 0;
	} catch {
		return 0; // ENOENT (or any read failure) ⇒ nothing appended yet this process/host.
	}
}

function truncateField(value: string): string {
	if (value.length <= MAX_FIELD_BYTES) return value;
	return value.slice(0, MAX_FIELD_BYTES) + TRUNCATED_SUFFIX;
}

/** Reserve (or reuse) this runId's chain entry SYNCHRONOUSLY — no `await` before `chains.set` — so N
 *  concurrent `appendCheckpoint` calls for the same runId in the same tick all observe the one entry
 *  this function creates, instead of each racing `lineCount` independently and all starting at seq 0. */
function chainFor(runId: string, file: string): { seq: number; chain: Promise<void> } {
	let entry = chains.get(runId);
	if (!entry) {
		entry = { seq: 0, chain: Promise.resolve() };
		chains.set(runId, entry);
		entry.chain = lineCount(file).then((n) => {
			entry!.seq = n;
		});
	}
	return entry;
}

/** Append one checkpoint line for `runId`, serialized per-runId so concurrent emissions never interleave
 *  or race the seq counter. `state.vars.lastOutput`/`lastText` are truncated to 4KB before serializing —
 *  a long-running fix-up loop otherwise appends hundreds of multi-KB gate outputs per run. */
export async function appendCheckpoint(stateDir: string, runId: string, state: WorkflowRunState & { headSha?: string }): Promise<void> {
	const file = checkpointLogPath(stateDir, runId);
	const entry = chainFor(runId, file);
	const run = entry.chain.then(async () => {
		const vars = state.vars ? { ...state.vars } : state.vars;
		if (vars?.lastOutput !== undefined) vars.lastOutput = truncateField(vars.lastOutput);
		if (vars?.lastText !== undefined) vars.lastText = truncateField(vars.lastText);
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
	return lineCount(checkpointLogPath(stateDir, runId));
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
