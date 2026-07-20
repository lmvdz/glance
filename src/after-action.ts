/**
 * After-action reports — the post-mortem a terminal unit owes its operator.
 *
 * The ompsq-416/417/418/446/447 incident: five workflow units hit CATASTROPHE on the same day, sat
 * in the roster as resurrected corpses across three days of daemon restarts, and the operator had to
 * hand-diagnose (gate red at the fork point — a dead export tripping the dead-exports ratchet before
 * any of them wrote a line) what the daemon already knew. Two gaps, one artifact each:
 *
 *   1. UNDERSTANDING was never made durable. The closest artifacts (failure-memory, reflection,
 *      symptoms, weekly-episode, answers) key on fingerprints, worktrees, repos, or ask-units —
 *      none on "this unit died, here is what happened, whose fault it was, and what to do next".
 *   2. DISPOSAL therefore could not be automated. `doctor` could only prescribe a manual
 *      `glance rm`, and `reconnectLive` faithfully reattached every terminal corpse on every boot.
 *
 * An after-action report mirrors answers.ts deliberately: durable (one JSON per unit, outliving the
 * roster row), addressable (`glance aar <id>` / `GET /api/after-action/:id`, id = the unit's own id),
 * and Schema-decoded on read (persisted state survives daemon upgrades — a genuine trust boundary).
 * With the report written, `selectTerminalReaps` (pure, fail-closed) is allowed to prune the corpse:
 * a terminal unit whose report exists AND that provably left nothing behind (0 commits ahead, 0 dirty
 * files — negative/unknown counts hold, never reap) is removed from the roster after a grace window.
 * A unit with salvageable work is held forever; the human decides, the report tells them how.
 */

import * as path from "node:path";
import { Schema } from "effect";
import { getStorageBackend } from "./dal/storage.ts";
import { redact } from "./redact.ts";
import { decodeJsonWith } from "./schema/external-json.ts";

/** Whose fault the terminal failure was, as far as the evidence can say. */
type AfterActionClassification = "environment" | "implementation" | "unknown";

export interface AfterActionReport {
	/** Same value as the dead unit's agent id — a report can always be traced to a transcript, and
	 *  re-reporting the same unit overwrites rather than duplicates (mirrors answers.ts). */
	id: string;
	name: string;
	repo: string;
	branch?: string;
	issueIdentifier?: string;
	issueUrl?: string;
	goal?: string;
	terminalReason: string;
	/** ms epoch the run went terminal (workflowState.terminal.at). */
	terminalAt: number;
	classification: AfterActionClassification;
	/** Commits the unit's branch is ahead of base; -1 = unknown (fail-closed everywhere it's read). */
	commitsAhead: number;
	/** Uncommitted files in the worktree at report time; -1 = unknown. */
	dirtyFiles: number;
	/** The rendered human-readable post-mortem. Contains redacted agent/gate output — render it,
	 *  never execute or re-prompt it. */
	markdown: string;
	createdAt: number;
}

const AfterActionSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	repo: Schema.String,
	branch: Schema.optional(Schema.String),
	issueIdentifier: Schema.optional(Schema.String),
	issueUrl: Schema.optional(Schema.String),
	goal: Schema.optional(Schema.String),
	terminalReason: Schema.String,
	terminalAt: Schema.Number,
	classification: Schema.Literals(["environment", "implementation", "unknown"]),
	commitsAhead: Schema.Number,
	dirtyFiles: Schema.Number,
	markdown: Schema.String,
	createdAt: Schema.Number,
});

const DIR = "after-action";

/** First line of the transcript entry that carries a report into the unit's chat history — the
 *  re-append-on-boot guard in squad-manager keys on it (reattachTerminal drops prior transcripts). */
export const AFTER_ACTION_MARKER = "📋 After-action report";

/** Same traversal guard as answers.ts: only the characters agent ids actually use survive. */
function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function file(stateDir: string, id: string): string {
	return path.join(stateDir, DIR, `${sanitizeId(id)}.json`);
}

/** Everything the composer needs, gathered by the (impure) caller. */
export interface AfterActionInput {
	id: string;
	name: string;
	repo: string;
	branch?: string;
	issueIdentifier?: string;
	issueUrl?: string;
	goal?: string;
	terminalReason: string;
	terminalAt: number;
	/** Stage labels in execution order (workflowState.rollup). */
	trajectory: string[];
	/** Per-node visit counts (workflowState.visits). */
	visits?: Record<string, number>;
	/** Tail of the last gate/verify output, if any survived (workflowState.vars.lastText). */
	gateTail?: string;
	commitsAhead: number;
	dirtyFiles: number;
	now: number;
}

const GATE_TAIL_CAP = 2_000;

/**
 * The classification heuristic, stated honestly in the markdown it produces:
 *   - environment: the unit left NOTHING behind (0 commits, 0 dirty files) yet its gate kept failing
 *     — the gate was red at the fork point, so the failure belongs to the base branch, not the unit.
 *     Exactly the ompsq-416..447 shape (and the incident after it: an unhandled test-suite error on
 *     main failing every fresh worktree's verify).
 *   - implementation: the unit produced changes that never passed the gate.
 *   - unknown: the evidence could not be gathered (-1 counts) — say so rather than guess.
 */
export function composeAfterAction(input: AfterActionInput): AfterActionReport {
	const { commitsAhead, dirtyFiles } = input;
	const classification: AfterActionClassification =
		commitsAhead < 0 || dirtyFiles < 0 ? "unknown" : commitsAhead === 0 && dirtyFiles === 0 ? "environment" : "implementation";
	return {
		id: input.id,
		name: input.name,
		repo: input.repo,
		branch: input.branch,
		issueIdentifier: input.issueIdentifier,
		issueUrl: input.issueUrl,
		goal: input.goal,
		terminalReason: input.terminalReason,
		terminalAt: input.terminalAt,
		classification,
		commitsAhead,
		dirtyFiles,
		markdown: renderMarkdown(input, classification),
		createdAt: input.now,
	};
}

function renderMarkdown(input: AfterActionInput, classification: AfterActionClassification): string {
	const visits = Object.entries(input.visits ?? {})
		.filter(([, n]) => n > 0)
		.map(([node, n]) => `${node} ×${n}`)
		.join(", ");
	const leftBehind =
		input.commitsAhead === 0 && input.dirtyFiles === 0
			? "Nothing — no commits ahead of base, no uncommitted edits. Removing this unit loses no work."
			: input.commitsAhead < 0 || input.dirtyFiles < 0
				? "Could not be determined (worktree or branch unreadable) — treat as salvageable until inspected."
				: `${input.commitsAhead} commit(s) ahead of base, ${input.dirtyFiles} uncommitted file(s)${input.branch ? ` on \`${input.branch}\`` : ""}.`;
	const why = {
		environment: "The verify gate kept failing while the work tree stayed unchanged — the gate was red at the fork point. This failure belongs to the base branch (or the gate environment), not to this unit. Any unit dispatched from the same base will die the same way until the base is fixed.",
		implementation: "The unit produced changes that never passed the verify gate. The work product survives on its branch/worktree for inspection.",
		unknown: "The evidence (commit/dirty counts) could not be gathered, so no fault call is made. Inspect the worktree before drawing conclusions.",
	}[classification];
	const nextSteps =
		classification === "environment"
			? [
					`Run the verify gate on the base branch of \`${input.repo}\` — it should fail there too; fix THAT first.`,
					input.issueIdentifier ? `Re-dispatch ${input.issueIdentifier} once the base gate is green.` : "Re-dispatch the goal once the base gate is green.",
					"This unit can be removed with nothing lost (auto-reap will do it after the grace window).",
				]
			: classification === "implementation"
				? [
						`Inspect what it built: \`glance diff ${input.id}\`${input.branch ? ` (branch \`${input.branch}\`)` : ""}.`,
						"Salvage the branch by hand, or re-dispatch with a larger fix-up budget.",
						"This unit is held from auto-reap while its work is unlanded — remove it explicitly once salvaged.",
					]
				: [`Inspect the worktree by hand: \`glance open ${input.id}\`.`, "Auto-reap holds this unit until the evidence is readable."];
	const tail = input.gateTail ? redact(input.gateTail).slice(-GATE_TAIL_CAP) : undefined;
	return [
		`# After-action report — ${input.name}`,
		"",
		`**What was attempted.** ${input.goal ?? input.terminalReason}${input.issueIdentifier ? ` (${input.issueIdentifier}${input.issueUrl ? `, ${input.issueUrl}` : ""})` : ""}`,
		"",
		`**How it died.** ${input.terminalReason} — at ${new Date(input.terminalAt).toISOString()}.`,
		"",
		...(input.trajectory.length ? [`**Trajectory.** ${input.trajectory.join(" → ")}${visits ? ` (${visits})` : ""}`, ""] : []),
		`**What it left behind.** ${leftBehind}`,
		"",
		`**Why (${classification}).** ${why}`,
		"",
		`**Next steps.**`,
		...nextSteps.map((s) => `- ${s}`),
		...(tail ? ["", "**Last gate output (tail, redacted).**", "", "```", tail, "```"] : []),
		"",
	].join("\n");
}

/** Never throws: a corrupt or missing report is "no report", not a crashed daemon. */
export async function readAfterAction(stateDir: string, id: string): Promise<AfterActionReport | undefined> {
	try {
		const raw = await getStorageBackend().readText(file(stateDir, id));
		if (raw === undefined) return undefined;
		return (decodeJsonWith(AfterActionSchema, raw) as AfterActionReport | null) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Newest first. A record that fails to decode is skipped, not fatal. */
export async function listAfterActions(stateDir: string): Promise<AfterActionReport[]> {
	const names = await getStorageBackend()
		.readdir(path.join(stateDir, DIR))
		.catch(() => [] as string[]);
	const out: AfterActionReport[] = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const r = await readAfterAction(stateDir, name.slice(0, -5));
		if (r) out.push(r);
	}
	return out.sort((x, y) => y.terminalAt - x.terminalAt);
}

/** Durable, atomic. Returns false when the write failed — the reaper must never prune a corpse whose
 *  report the next restart will disagree exists. */
export async function saveAfterAction(stateDir: string, report: AfterActionReport): Promise<boolean> {
	try {
		await getStorageBackend().writeDurable(file(stateDir, report.id), JSON.stringify(report, null, 2));
		return true;
	} catch {
		return false;
	}
}

export interface TerminalReapCandidate {
	id: string;
	/** ms epoch the run went terminal. */
	terminalAt: number;
	/** -1 = unknown; anything but exactly 0 holds (same fail-closed discipline as worktree-reaper). */
	commitsAhead: number;
	/** -1 = unknown; anything but exactly 0 holds. */
	dirtyFiles: number;
	/** The after-action report is durably on disk — the precondition for pruning the roster row. */
	hasReport: boolean;
}

/**
 * Pure reap policy for terminal roster rows (the corpses `reconnectLive` otherwise reattaches on
 * every boot, forever). Reap ONLY when every condition holds; everything else is held with a named
 * reason. Exact-equality zero checks by design: -1 "unknown" (or any nonzero) reads as "might hold
 * work" — never reap what we couldn't verify is worthless. Do not change to `> 0` / `< 0`.
 */
export function selectTerminalReaps(args: { candidates: TerminalReapCandidate[]; now: number; graceMs: number }): {
	reap: string[];
	held: { id: string; reason: string }[];
} {
	const reap: string[] = [];
	const held: { id: string; reason: string }[] = [];
	for (const c of args.candidates) {
		if (!c.hasReport) held.push({ id: c.id, reason: "no after-action report written yet" });
		else if (args.now - c.terminalAt < args.graceMs) held.push({ id: c.id, reason: "within grace window" });
		else if (c.commitsAhead !== 0) held.push({ id: c.id, reason: c.commitsAhead < 0 ? "commit count unknown" : `${c.commitsAhead} unlanded commit(s)` });
		else if (c.dirtyFiles !== 0) held.push({ id: c.id, reason: c.dirtyFiles < 0 ? "dirty state unknown" : `${c.dirtyFiles} uncommitted file(s)` });
		else reap.push(c.id);
	}
	return { reap, held };
}
