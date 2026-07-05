/**
 * Reflexion between fixups (agentic-learning-loop concern 04) — turn a blind retry into a learning
 * retry. Between fixup attempts, generate a short natural-language root-cause note from the LATEST
 * failing command output and inject it (fenced as untrusted) into the next attempt.
 *
 * Design constraints carried over verbatim from DESIGN.md (do not re-litigate here):
 *  - `reflect()` is best-effort and NEVER throws — an unhandled reject here would crash the daemon's
 *    orchestrator/workflow tick, the same discipline `proof.ts`/`decideTyped` already follow.
 *  - Refutation, not accumulation: only the single most-recent reflection is ever injected. If the
 *    failing output hasn't changed since the last attempt, the prior hypothesis clearly didn't fix
 *    it — tell the model that plainly instead of re-guessing (or re-spending an LLM call) on the
 *    identical evidence.
 *  - Persistence is one JSONL file PER WORKTREE (mirrors `proof.ts`'s per-worktree file pattern, NOT
 *    a shared append-only log — the codebase already got burned by shared-append corruption in the
 *    scout-seen store). Reads tolerate a torn trailing line.
 */

import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { decideTyped, extractJsonObject } from "./omp-call.ts";

export interface Reflection {
	rootCause: string;
	whatToDoDifferently: string;
	/** Hash of the failing output this reflection was generated from — the refutation key: an
	 *  unchanged hash on the NEXT attempt means the hypothesis didn't fix anything. */
	outputHash: string;
}

/** A reflection as persisted to disk, source-tagged for future scoped retrieval (concern 05). */
export interface StoredReflection extends Reflection {
	agentId?: string;
	runId?: string;
	repo?: string;
	at: number;
}

/** Injected LLM seam — mirrors `Judge`/`Classify`: the default is a real one-shot `omp -p` call,
 *  tests pass a fake. Returning `undefined` (or throwing) degrades to "no reflection this round". */
export type ReflectLlm = (input: { output: string; prior?: Reflection }) => Promise<{ rootCause: string; whatToDoDifferently?: string } | undefined>;

function reflectModel(): string {
	return process.env.OMP_SQUAD_REFLECT_MODEL || "haiku";
}

interface RawReflection {
	rootCause?: unknown;
	whatToDoDifferently?: unknown;
}

function parseRawReflection(raw: string): { rootCause: string; whatToDoDifferently?: string } | undefined {
	const obj = extractJsonObject(raw) as RawReflection | undefined;
	const rootCause = typeof obj?.rootCause === "string" ? obj.rootCause.trim() : "";
	if (!rootCause) return undefined;
	const whatToDoDifferently = typeof obj?.whatToDoDifferently === "string" ? obj.whatToDoDifferently.trim() : undefined;
	return { rootCause, whatToDoDifferently };
}

const SYSTEM_PROMPT =
	"You analyze a FAILED command's output and propose a root cause for why it failed. " +
	"Reply with ONLY one JSON object, no prose, no code fences: " +
	'{"rootCause":"<one sentence, the likely reason this failed>","whatToDoDifferently":"<one sentence, a concrete next step>"}.';

/** Default reflect LLM: a cheap one-shot `omp -p` call. Unreachable/unparseable degrades to
 *  `undefined` via `decideTyped`'s fallback — never throws. */
function defaultReflectLlm(): ReflectLlm {
	return ({ output, prior }) => {
		const priorNote = prior ? `\n\nA PRIOR hypothesis was tried and did NOT fix this: "${prior.rootCause}". Propose a DIFFERENT root cause.` : "";
		const user = `Failed command output (tail):\n${output.slice(-4000)}${priorNote}`;
		return decideTyped<{ rootCause: string; whatToDoDifferently?: string } | undefined>({
			args: ["-p", "--model", reflectModel(), "--system-prompt", SYSTEM_PROMPT, user],
			parse: parseRawReflection,
			fallback: undefined,
			timeoutMs: Number(process.env.OMP_SQUAD_REFLECT_TIMEOUT_MS) || 20_000,
		});
	};
}

export function hashOutput(output: string): string {
	return createHash("sha1").update(output).digest("hex").slice(0, 16);
}

/**
 * Generate a root-cause reflection from the latest failing output. NEVER throws — on any error
 * (llm rejects, empty/unparseable response) resolves `null` so the caller proceeds unblocked.
 */
export async function reflect(input: { output: string; prior?: Reflection }, llm: ReflectLlm = defaultReflectLlm()): Promise<Reflection | null> {
	try {
		const r = await llm({ output: input.output, prior: input.prior });
		if (!r?.rootCause) return null;
		return { rootCause: r.rootCause, whatToDoDifferently: r.whatToDoDifferently ?? "", outputHash: hashOutput(input.output) };
	} catch {
		return null;
	}
}

/** Render a reflection (or a refutation of the prior one) as the note to inject into the next
 *  fixup prompt, UNFENCED — the caller is responsible for fencing (mirrors `buildContextPrimer`'s
 *  internal-fence discipline; this module has no primer/prose builder of its own to own that). */
export function renderReflectionNote(r: Reflection): string {
	return r.whatToDoDifferently ? `Likely root cause: ${r.rootCause}\nTry instead: ${r.whatToDoDifferently}` : `Likely root cause: ${r.rootCause}`;
}

/** Refutation framing when the latest failure output is UNCHANGED from the reflection's own
 *  outputHash — the prior hypothesis provably did not fix anything; say so instead of re-guessing. */
export function renderRefutationNote(prior: Reflection): string {
	return `The previous hypothesis did NOT fix this (the failure is identical): "${prior.rootCause}". Try a genuinely different approach.`;
}

// ── per-worktree persistence (proof.ts pattern: one file per worktree, JSONL, torn-line tolerant) ──

function reflectionFile(stateDir: string, repo: string, worktree: string): string {
	const repoHash = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
	const wtHash = createHash("sha1").update(path.resolve(worktree)).digest("hex").slice(0, 20);
	return path.join(stateDir, "reflections", repoHash, `${wtHash}.jsonl`);
}

/** Append one reflection for this worktree. Best-effort: a disk failure must never break the fixup
 *  it was generated for. */
export async function appendReflection(stateDir: string, repo: string, worktree: string, r: StoredReflection): Promise<void> {
	try {
		const file = reflectionFile(stateDir, repo, worktree);
		await fsp.mkdir(path.dirname(file), { recursive: true });
		await fsp.appendFile(file, `${JSON.stringify(r)}\n`);
	} catch {
		/* best-effort: reflexion is an aid, never load-bearing */
	}
}

/** The most recently appended reflection for this worktree, or `undefined`. Tolerates a torn
 *  trailing line (parses per-line from the end, skipping unparseable ones) — never throws. */
export async function latestReflection(stateDir: string, repo: string, worktree: string): Promise<StoredReflection | undefined> {
	try {
		const text = await fsp.readFile(reflectionFile(stateDir, repo, worktree), "utf8");
		const lines = text.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				return JSON.parse(lines[i]!) as StoredReflection;
			} catch {
				continue; // torn/corrupt line — try the one before it
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}
