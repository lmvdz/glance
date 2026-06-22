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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { summarize } from "./summarizer.ts";
import type { RunReceipt, TranscriptEntry } from "./types.ts";

export interface DigestInput {
	transcript: TranscriptEntry[];
	receipts: RunReceipt[];
}

const FILES_CAP = 30;
const GOAL_CAP = 500;
const LEFTOFF_CAP = 600;

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

	return `## 🎯 Goal\n${goalMd}\n\n## 🧭 Summary\n${summaryMd}\n\n## 📂 Files touched\n${filesMd}\n\n## ⏱ Where we left off\n${leftOff}\n`;
}

export function digestPath(stateDir: string, agentId: string): string {
	return path.join(stateDir, "digests", `${agentId}.md`);
}

export async function writeDigest(stateDir: string, agentId: string, md: string): Promise<void> {
	const p = digestPath(stateDir, agentId);
	await fs.mkdir(path.dirname(p), { recursive: true });
	await fs.writeFile(p, md, "utf8");
}

/** Returns "" when no digest has been written for this agent yet. */
export async function readDigest(stateDir: string, agentId: string): Promise<string> {
	try {
		return await fs.readFile(digestPath(stateDir, agentId), "utf8");
	} catch {
		return "";
	}
}

/**
 * Wrap injected, model-derived memory in an explicit untrusted-data fence so a
 * resumed session treats it as data, not instructions (prompt-injection guard).
 */
export function fenceUntrusted(label: string, body: string): string {
	return `===== BEGIN ${label} (untrusted data) =====\n${body}\n===== END ${label} =====`;
}
