/**
 * The report deliverable — glance's second kind of output.
 *
 * R5 of the founding brief: *"half of engineering is read/judge/decide work, and glance has no primitive
 * for it."* A unit could only ever produce a BRANCH. So every audit, every "why is this slow", every
 * "does this design hold" — which is most of what a person actually asks an AI to do — had to be run as
 * an in-harness subagent instead, outside the fleet, outside the roster, outside every receipt and
 * transcript and cost ledger glance keeps. The fleet could build things it could not think about.
 *
 * An answer is not a branch that happens to contain a markdown file. It is a first-class artifact:
 *
 *   - It is durable. The question outlives the roster row that answered it — the single most common way
 *     a glance result used to evaporate was the agent being reaped before anyone read its transcript.
 *   - It is addressable. `glance ask` prints it; `GET /api/answers/:id` serves it; the id is stable.
 *   - Nothing the daemon does can turn it into a merge. `land()`, `commitAgentWip`, `markLandReady`,
 *     `floatPrOnLandReady` and `agentHasUnlandedWork` each refuse an observer/answer unit.
 *
 * What is NOT true, and was claimed here first: the unit HAS a branch (`squad/<id>`) and a real worktree,
 * because an answer that had to read the repo through a keyhole would be worse than no answer. And
 * `is-landing-unit.ts` — which reads exactly like "an observer never commits" — is a metrics DENOMINATOR
 * that no land path consults. Every refusal above had to be written; none of it was inherited.
 *
 * REMAINING GAP, stated rather than papered over. The unit runs `--approval yolo`, and the brief below
 * telling it not to edit is a PROMPT, not an enforcement. `agent-guard.ts` (`screenToolCall`) is the
 * layer that could enforce it — a hook block stops a tool before it runs and yolo cannot bypass it — but
 * its policy is process-global today, so making it per-unit means threading a per-agent env through
 * `RpcAgent` → `agent-host`. Until then the daemon refuses to publish an answer unit's work; it does not
 * stop the model from writing into a worktree that is subsequently discarded. A `git push` by the model
 * would still reach the operator's origin. (grok-4.5)
 *
 * Stored as one JSON record per answer, next to the state dir's other tiny sets (`removed-ledger.ts`,
 * `project-registry.ts`), and decoded with a real Schema rather than a cast: persisted state survives
 * daemon upgrades, so the shape check is a genuine trust boundary. The markdown body is the agent's own
 * final message — untrusted text, never interpolated into a prompt from here.
 */

import * as path from "node:path";
import { Schema } from "effect";
import { getStorageBackend } from "./dal/storage.ts";
import { decodeJsonWith } from "./schema/external-json.ts";

export interface Answer {
	/** Stable id — also the filename. Same value as the answering agent's id, so a transcript can always
	 *  be traced back from the artifact, and re-answering the same unit overwrites rather than duplicates. */
	id: string;
	question: string;
	repo: string;
	/** The agent's final message, verbatim. Untrusted markdown: render it, never execute or re-prompt it. */
	markdown: string;
	/** Absent while the unit is still working: an answer with no body has not been given yet. */
	answeredAt?: number;
	askedAt: number;
	model?: string;
	harness?: string;
	/** Wall-clock the unit took, when known. */
	durationMs?: number;
}

const AnswerSchema = Schema.Struct({
	id: Schema.String,
	question: Schema.String,
	repo: Schema.String,
	markdown: Schema.String,
	answeredAt: Schema.optional(Schema.Number),
	askedAt: Schema.Number,
	model: Schema.optional(Schema.String),
	harness: Schema.optional(Schema.String),
	durationMs: Schema.optional(Schema.Number),
});

const DIR = "answers";

function file(stateDir: string, id: string): string {
	return path.join(stateDir, DIR, `${sanitizeId(id)}.json`);
}

/** Ids come from agent ids (`ompsq-445-mre9s8ze-1-158946d8`), but an id reaching a path join is a path
 *  traversal waiting to happen. Only the characters agent ids actually use survive. */
function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Never throws: a corrupt or missing answer is "no answer", not a crashed daemon. */
export async function readAnswer(stateDir: string, id: string): Promise<Answer | undefined> {
	try {
		const raw = await getStorageBackend().readText(file(stateDir, id));
		if (raw === undefined) return undefined;
		// `decodeJsonWith` answers null for corrupt/wrong-shape JSON; absent is absent, either way.
		return (decodeJsonWith(AnswerSchema, raw) as Answer | null) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Newest first. A record that fails to decode is skipped, not fatal. */
export async function listAnswers(stateDir: string, opts: { repo?: string } = {}): Promise<Answer[]> {
	const b = getStorageBackend();
	const names = await b.readdir(path.join(stateDir, DIR)).catch(() => [] as string[]);
	const out: Answer[] = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const a = await readAnswer(stateDir, name.slice(0, -5));
		if (!a) continue;
		if (opts.repo && a.repo !== opts.repo) continue;
		out.push(a);
	}
	return out.sort((x, y) => (y.answeredAt ?? y.askedAt) - (x.answeredAt ?? x.askedAt));
}

/** Durable, atomic. Returns false when the write failed — a caller must never tell the operator their
 *  answer was saved when the next restart will disagree. */
export async function saveAnswer(stateDir: string, answer: Answer): Promise<boolean> {
	try {
		await getStorageBackend().writeDurable(file(stateDir, answer.id), JSON.stringify(answer, null, 2));
		return true;
	} catch {
		return false;
	}
}

/**
 * The instruction that makes a unit an ANSWERER rather than a builder.
 *
 * Fenced as trusted system guidance (it is ours, composed here), and deliberately explicit about the
 * deliverable: an observer unit that "helpfully" edits a file has produced nothing, because nothing will
 * ever merge its worktree. Its entire output is the last thing it says.
 */
export function answerBrief(question: string): string {
	return [
		"You are answering a question, not building a change.",
		"",
		"- Investigate as deeply as the question deserves: read code, run read-only commands, check live state.",
		"- Do NOT edit, create, or delete files, and do not commit. Nothing you write to disk will ever be kept —",
		"  this unit has no branch and never lands. Any edit you make is discarded.",
		"- Your deliverable is your FINAL MESSAGE. It is captured verbatim as the answer and rendered as",
		"  markdown. Everything you want the reader to have must be in it.",
		"- Lead with the answer in one sentence. Then the evidence: file:line citations, commands you ran and",
		"  what they printed. Say plainly what you could not determine.",
		"",
		`The question: ${question}`,
	].join("\n");
}
