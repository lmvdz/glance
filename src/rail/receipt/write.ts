/**
 * The receipt WRITE + POST side (glance#334, rail T6) — the only impure part of the receipt lane. It
 * writes the self-contained HTML file beside the land ledger (under `<stateDir>`, NEVER a git-tracked
 * path — a receipt must never dirty the land tree; that was T5's mistake) and posts the compact
 * comment to the PR via `gh`.
 *
 * The renderers (`render-html.ts`, `render-comment.ts`) are pure and golden-tested; this module just
 * moves their output to disk / GitHub. It also owns `classifyLand`, the single documented place that
 * distills a `LandResult` into the receipt's proof facts — so the fragile detail-string reads live in
 * ONE place, tested, rather than scattered as substring checks (mirroring, and centralizing, the
 * pattern squad-manager already uses for its red-baseline DoneProof note; see its TODO at the
 * `recordDoneProof` call).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LandResult } from "../../land.ts";
import { gh } from "../../gh.ts";
import type { LandReceiptGate } from "./types.ts";
import type { LandReceipt } from "./types.ts";
import { renderReceiptHtml } from "./render-html.ts";
import { renderReceiptComment, type CommentOptions } from "./render-comment.ts";

/** Where land receipts live: `<stateDir>/land-receipts/` — beside `land-failures.json` (the land
 *  ledger), NOT under the run-receipts `receipts/` dir (those are JSONL per-run cost records, a
 *  different artifact) and NOT anywhere git-tracked. */
export function landReceiptDir(stateDir: string): string {
	return path.join(stateDir, "land-receipts");
}

/** A filesystem-safe, collision-resistant receipt filename for a land: branch (sanitized) + timestamp.
 *  Distinct lands on the same branch get distinct files — a receipt is a point-in-time record, never
 *  overwritten. */
export function landReceiptFilename(branch: string, at: number): string {
	const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "land";
	return `${safe}-${at}.html`;
}

/**
 * Distill a `LandResult` into the receipt's proof facts. Pure. The status + failure-set diff are not
 * carried as structured fields on `LandResult` (only its `detail` string is), so this reads the detail
 * with the SAME wording the land path emits — documented and tested here rather than guessed inline.
 * If land.ts's wording ever changes, the receipt degrades gracefully (status falls back to
 * ok⇒green / !ok⇒failed, failure list empties) rather than lying — and the tests here pin the wording.
 */
export function classifyLand(result: LandResult): LandReceiptGate {
	const detail = result.detail ?? "";
	const lower = detail.toLowerCase();
	const baseWasRed = lower.includes("red baseline") || lower.includes("already-red base") || lower.includes("already red");
	const unprovenGreenRejected = lower.includes("could not be trusted") || lower.includes("unproven pass");
	const noGate = lower.includes("no acceptance gate");
	const newRegressions = parseNewRegressions(detail);

	let status: LandReceiptGate["status"];
	if (!result.ok) {
		status = unprovenGreenRejected ? "unproven-rejected" : "failed";
	} else if (baseWasRed) {
		status = "red-baseline";
	} else if (noGate) {
		status = "no-gate";
	} else {
		status = "green";
	}

	// The acceptance-gate command, when the detail names it as "verified (<cmd>)" or "(<cmd>) blocked".
	const cmdMatch = detail.match(/verified \(([^)]+)\)/) ?? detail.match(/gate \(([^)]+)\)/);
	return {
		status,
		command: cmdMatch?.[1],
		unprovenGreenRejected,
		newRegressions,
		baseWasRed,
		detail: detail ? detail.slice(0, 800) : undefined,
	};
}

/** Extract the itemized new-failure list the land detail prints after "new failure(s):" — the lines
 *  land.ts renders as `  ${newRegressions.join("\n  ")}`. Returns [] when none present. */
function parseNewRegressions(detail: string): string[] {
	const marker = detail.search(/new failure\(s\)/i);
	if (marker === -1) return [];
	const after = detail.slice(marker);
	const colon = after.indexOf(":");
	if (colon === -1) return [];
	const lines = after.slice(colon + 1).split("\n");
	const out: string[] = [];
	for (const raw of lines) {
		// The list is indented two spaces; the first stretch of indented lines IS the list. Stop at the
		// first non-indented, non-empty line (the reduced gate-output excerpt that follows).
		if (/^\s{2,}\S/.test(raw)) out.push(raw.trim());
		else if (raw.trim() === "") continue;
		else if (out.length > 0) break;
	}
	return out;
}

/**
 * Write the self-contained HTML receipt under `<stateDir>/land-receipts/`. Returns the absolute path.
 * Best-effort caller contract: a receipt-write failure must NEVER fail the land — the caller wraps
 * this in a try/catch (same posture as every other post-land ledger write).
 */
export async function writeLandReceipt(stateDir: string, receipt: LandReceipt): Promise<string> {
	const dir = landReceiptDir(stateDir);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, landReceiptFilename(receipt.branch, receipt.at));
	await fs.writeFile(file, renderReceiptHtml(receipt), "utf8");
	return file;
}

/**
 * Post the compact receipt comment to a PR via `gh pr comment`. `repoSlug` must be "owner/repo".
 * Returns true on success. Never throws — a comment failure must never fail a land; `gh`'s own wrapper
 * already degrades a missing binary to a non-zero code rather than throwing.
 */
export async function postReceiptComment(
	repoCwd: string,
	repoSlug: string,
	prNumber: number,
	receipt: LandReceipt,
	opts: CommentOptions = {},
): Promise<boolean> {
	const body = renderReceiptComment(receipt, opts);
	const r = await gh(["pr", "comment", String(prNumber), "--repo", repoSlug, "--body", body], repoCwd);
	return r.code === 0;
}
