/**
 * Zero-token transcript digests for cold-start resume.
 *
 * On run-end the manager builds a compact markdown digest of an agent's
 * transcript + receipts and persists it under <stateDir>/digests/<id>.md. On
 * restart that digest is surfaced (fenced as untrusted data) so the operator
 * sees where the prior session left off — no LLM, no network, no model spend.
 * Only the Summary section is ranked (extractive summarizer); every other
 * section is derived deterministically from the inputs.
 */

import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import { summarize } from "./summarizer.ts";
import type { RunReceipt, TranscriptEntry } from "./types.ts";

/**
 * Reward-boost tag (agentic-learning-loop concern 03) — a fresh-checked proof outcome for the run
 * this digest summarizes. Boost-only by contract: `ok`/`fresh` false just means "not a top-tier
 * signal", never "penalize" — a missing tag (no proof ran) is `null`, not a negative reward.
 */
export interface DigestReward {
	/** The recorded proof passed. */
	ok: boolean;
	/** The proof matched the exact tree/branch/base being summarized (see `isFresh` in proof.ts) —
	 *  an `ok:true` but stale proof is treated as UNKNOWN for reward purposes, not a pass. */
	fresh: boolean;
	/** Passed on the FIRST attempt (zero fixup visits) — the only tier that earns the top boost. */
	firstTryGreen: boolean;
}

export interface DigestInput {
	transcript: TranscriptEntry[];
	receipts: RunReceipt[];
	/** Reward tag to embed (concern 03). `undefined`/`null` ⇒ no tag (baseline weight at retrieval
	 *  time) — absence of a signal is unknown, never a penalty. */
	reward?: DigestReward | null;
}

const FILES_CAP = 30;
const GOAL_CAP = 500;
const LEFTOFF_CAP = 600;

/** The HTML-comment line a reward tag is embedded as — invisible in a rendered markdown view, kept
 *  out of the prose sections. `parseDigestReward` is this function's exact inverse. */
export function formatRewardTag(reward: DigestReward): string {
	return `<!-- omp-squad:reward ok=${reward.ok} fresh=${reward.fresh} firstTryGreen=${reward.firstTryGreen} -->`;
}

const REWARD_TAG_RE = /<!--\s*omp-squad:reward\s+ok=(true|false)\s+fresh=(true|false)\s+firstTryGreen=(true|false)\s*-->/;

/** Recover a digest's embedded reward tag, or `null` when absent/unparseable — the retrieval-time
 *  reader (fabric-search.ts) treats `null` the same as "no signal" (baseline weight). */
export function parseDigestReward(md: string): DigestReward | null {
	const m = REWARD_TAG_RE.exec(md);
	if (!m) return null;
	return { ok: m[1] === "true", fresh: m[2] === "true", firstTryGreen: m[3] === "true" };
}

/**
 * Multiplicative retrieval-weight prior from a reward tag — boost-only: `firstTryGreen` (verified,
 * zero-fixup) beats `ok+fresh` (verified but thrashed) beats everything else, and NOTHING ever
 * scores below the 1.0 baseline (a failed/stale/absent proof is "unknown", not "bad"). Fed straight
 * into the existing `KbDoc.weight` BM25 fold (fabric-search.ts) — no new ranking logic.
 */
export function rewardWeight(reward: DigestReward | null): number | undefined {
	if (!reward) return undefined; // no tag ⇒ baseline (no fold applied)
	if (reward.ok && reward.fresh && reward.firstTryGreen) return 1.6;
	if (reward.ok && reward.fresh) return 1.3;
	return undefined; // failed / stale / unfresh ⇒ unknown, never below baseline
}

function bullets(items: string[], limit: number): string {
	if (items.length === 0) return "_(none)_";
	const out = items.slice(0, limit).map((it) => `- ${it}`);
	if (items.length > limit) out.push(`- …and ${items.length - limit} more`);
	return out.join("\n");
}

/** Union of touched files across receipts, first-seen order preserved. */
function touchedFiles(receipts: RunReceipt[]): string[] {
	const seen = new Set<string>();
	const files: string[] = [];
	for (const r of receipts) {
		for (const f of r.filesTouched ?? []) {
			if (!seen.has(f)) {
				seen.add(f);
				files.push(f);
			}
		}
	}
	return files;
}

/** Compact markdown digest. Deterministic facts verbatim; only Summary is ranked. */
export function buildDigest(input: DigestInput): string {
	const { transcript, receipts } = input;
	const goal = transcript.find((e) => e.kind === "user")?.text ?? "";
	const prose = transcript
		.filter((e) => e.kind === "user" || e.kind === "assistant")
		.map((e) => e.text)
		.join("\n");
	const summary = summarize(prose, 8);
	const lastAssistant = [...transcript].reverse().find((e) => e.kind === "assistant")?.text ?? "";

	const goalMd = goal ? (goal.length > GOAL_CAP ? goal.slice(0, GOAL_CAP) + "…" : goal) : "_(not detected)_";
	const summaryMd = summary.length ? summary.map((s) => `- ${s}`).join("\n") : "_(not enough captured to summarize)_";
	const filesMd = bullets(touchedFiles(receipts), FILES_CAP);
	const leftOff = lastAssistant ? (lastAssistant.length > LEFTOFF_CAP ? lastAssistant.slice(0, LEFTOFF_CAP) + "…" : lastAssistant) : "_(unknown)_";

	// Reward tag (concern 03): a structured HTML-comment line, kept OUT of the prose sections above so
	// it never pollutes a human-facing digest view — readers that render this markdown should leave it
	// invisible, exactly like they already do for any other HTML comment.
	const rewardMd = input.reward ? `\n${formatRewardTag(input.reward)}\n` : "";

	return `## 🎯 Goal\n${goalMd}\n\n## 🧭 Summary\n${summaryMd}\n\n## 📂 Files touched\n${filesMd}\n\n## ⏱ Where we left off\n${leftOff}\n${rewardMd}`;
}

export function digestPath(stateDir: string, agentId: string): string {
	return path.join(stateDir, "digests", `${agentId}.md`);
}

export async function writeDigest(stateDir: string, agentId: string, md: string): Promise<void> {
	const p = digestPath(stateDir, agentId);
	await getStorageBackend().writeDurable(p, md);
}

/** Returns "" when no digest has been written for this agent yet. */
export async function readDigest(stateDir: string, agentId: string): Promise<string> {
	const raw = await getStorageBackend().readText(digestPath(stateDir, agentId));
	return raw ?? "";
}

/** Longest untrusted body we will fence. Everything reaching this function is attacker-influenced text
 *  destined for a system prompt or an argv element; an unbounded issue body or digest would otherwise be
 *  spliced straight into `--append-system-prompt` and can blow ARG_MAX. Truncation is visible. */
const MAX_FENCED = 24_000;

/** The delimiter is a fixed, guessable string, and the fenced text is written BY the agents we are
 *  fencing against. Any `=====` run inside the body is folded to the box-drawing double line: it reads
 *  identically to a human and to a model, but can never byte-match a real delimiter, so a digest that
 *  contains `===== END context primer =====` cannot close its own fence and continue as instructions. */
function neutralizeDelimiters(text: string): string {
	return text.replace(/={5,}/g, (run) => "═".repeat(run.length));
}

/** The label is interpolated INTO the delimiter line, and one caller builds it from an actor id
 *  (`peer message from ${actor.id}`). A newline there breaks the delimiter across lines and lets the
 *  attacker write the rest of the fence themselves; an unbounded label pushes the real delimiter past
 *  anything a reader (or model) will attend to. Collapse control characters, cap it. (gpt-5.6-sol) */
function sanitizeLabel(label: string): string {
	// eslint-disable-next-line no-control-regex -- the point is to strip them
	const flat = neutralizeDelimiters(label).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat || "untrusted";
}

/**
 * Wrap injected, model-derived memory in an explicit untrusted-data fence so a resumed session treats it
 * as data, not instructions (prompt-injection guard).
 *
 * The single choke point for every untrusted injection: resume digests, peer messages, workflow
 * reflections, authored issue specs, and the cold-start context primer. Escaping happens HERE so no
 * future injector can forget it — the same reason `buildContextPrimer` fences internally and forbids its
 * callers from re-fencing. Before this, a unit could write `===== END resume digest =====` into its own
 * digest and hand the next unit's model a forged instruction block.
 */
export function fenceUntrusted(label: string, body: string): string {
	const safeLabel = sanitizeLabel(label);
	const clipped = body.length > MAX_FENCED ? `${body.slice(0, MAX_FENCED)}\n… [truncated ${body.length - MAX_FENCED} chars]` : body;
	return `===== BEGIN ${safeLabel} (untrusted data) =====\n${neutralizeDelimiters(clipped)}\n===== END ${safeLabel} =====`;
}

/**
 * The authored-spec block injected into a dispatched unit's context (learn-harness-engineering
 * "repo IS the spec"): the concern/Tier-2 body, fenced as UNTRUSTED data so a human/skills-MCP-writable
 * issue body can never act as instructions to a yolo agent. Undefined (title-only, no regression) when
 * the body is empty/absent.
 */
export function authoredSpecBlock(description: string | undefined): string | undefined {
	const spec = description?.trim();
	return spec ? fenceUntrusted("authored task spec", spec) : undefined;
}
