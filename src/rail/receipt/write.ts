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
import type { LandReceipt, LandReceiptIndexRow } from "./types.ts";
import { renderReceiptHtml } from "./render-html.ts";
import { renderReceiptComment, type CommentOptions } from "./render-comment.ts";

/** Where land receipts live: `<stateDir>/land-receipts/` — beside `land-failures.json` (the land
 *  ledger), NOT under the run-receipts `receipts/` dir (those are JSONL per-run cost records, a
 *  different artifact) and NOT anywhere git-tracked. */
export function landReceiptDir(stateDir: string): string {
	return path.join(stateDir, "land-receipts");
}

/**
 * A filesystem-safe, collision-resistant receipt filename: sanitized branch + timestamp + a UNIQUE
 * token. The token is the landed commit SHA when known, else random — WITHOUT it, the lossy branch
 * sanitizer (`feature/a+b` and `feature/a-b` both → `feature-a-b`) plus a same-millisecond timestamp
 * would collide across two concurrent cross-repo lands that share one stateDir, and the second would
 * silently overwrite the first (gauntlet round 1, codex MEDIUM). `writeLandReceipt` additionally
 * refuses to overwrite an existing file, so even a token collision never destroys a prior receipt.
 */
export function landReceiptFilename(branch: string, at: number, token?: string): string {
	const safe = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "land";
	const uniq = (token && token.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 12)) || Math.random().toString(36).slice(2, 10);
	return `${safe}-${at}-${uniq}.html`;
}

/** The structured, append-only index beside the HTML receipts: `<stateDir>/land-receipts/index.jsonl`.
 *  One `LandReceiptIndexRow` per land — the countable substrate the dogfood counter (`land-metrics.ts`)
 *  reads. The HTML files are for humans; this is for counting. */
export const LAND_RECEIPT_INDEX_FILE = "index.jsonl";
export function landReceiptIndexPath(stateDir: string): string {
	return path.join(landReceiptDir(stateDir), LAND_RECEIPT_INDEX_FILE);
}

/**
 * Distill a `LandReceipt` into its structured index row. Pure. The precision field is carried ONLY
 * when a validator actually ran and stamped a lineage — a land with no validator gets no `precision`
 * key at all (never a fabricated zero-precision object), so the counter can tell "unmeasured" from
 * "measured with n=0" by presence, exactly as the receipt itself does.
 */
export function landReceiptIndexRow(receipt: LandReceipt): LandReceiptIndexRow {
	const p = receipt.validation?.reviewerPrecision;
	return {
		at: receipt.at,
		repo: receipt.repo,
		branch: receipt.branch,
		...(receipt.commit ? { commit: receipt.commit } : {}),
		landed: receipt.landed,
		forced: receipt.forcedWithoutProof,
		gateStatus: receipt.gate.status,
		...(p ? { precision: { lineage: p.lineage, n: p.n, survived: p.survived } } : {}),
	};
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
	const html = renderReceiptHtml(receipt);
	// `wx` = fail if the path exists — a receipt is an immutable point-in-time record and must never be
	// silently overwritten. On the astronomically-rare collision (same branch, ms, and token), retry with
	// a fresh random token rather than clobber the existing receipt or throw the land's best-effort call.
	for (let attempt = 0; attempt < 5; attempt++) {
		const token = attempt === 0 ? receipt.commit : undefined; // attempt 0 uses the commit SHA; retries force random
		const file = path.join(dir, landReceiptFilename(receipt.branch, receipt.at, token));
		try {
			await fs.writeFile(file, html, { encoding: "utf8", flag: "wx" });
			// Append the structured index row (the dogfood counter's substrate) beside the HTML we just
			// wrote. Deliberately its OWN try/catch, separate from the caller's best-effort land wrapper:
			// an index-append failure must never lose the human-facing HTML receipt already on disk, so it
			// is swallowed here. Undercounting is the failure mode, never a lost receipt or a failed land.
			try {
				await fs.appendFile(landReceiptIndexPath(stateDir), JSON.stringify(landReceiptIndexRow(receipt)) + "\n", "utf8");
			} catch {
				/* index is best-effort; the HTML receipt is the durable record */
			}
			return file;
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
			// existing receipt at this name — loop to mint a new random token
		}
	}
	throw new Error("writeLandReceipt: could not mint a non-colliding receipt filename after 5 attempts");
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
