/**
 * Adapt T6's receipt renderer to the Checks API `output` surface (glance#337, rail T9). REUSES
 * `renderReceiptComment` (render-comment.ts) verbatim rather than re-implementing any receipt
 * rendering — that function is already pure markdown (GFM, `<details>` blocks with the required
 * blank line after `</summary>`, every agent-authored field passed through `mdEsc`) and is exactly
 * the shape a check-run's `output.text` field expects (Checks API output is GFM-rendered markdown,
 * NOT raw HTML — `render-html.ts`'s standalone `<html>` document would NOT render there, only paste
 * through inert).
 *
 * `output.summary` reuses the comment's own first line (`### ${verdict}`) rather than re-deriving the
 * verdict word from `LandReceipt.gate.status` a second time — the single source of truth for "what
 * does this land's status say" stays render-comment.ts's `verdict()`, which this module never
 * duplicates.
 */

import type { LandReceipt } from "../receipt/types.ts";
import { mdEsc, renderReceiptComment } from "../receipt/render-comment.ts";
import type { AuthorshipVerdict } from "./authorship.ts";
import type { PullRequestInfo } from "./pull-request.ts";

export interface CheckRunOutput {
	title: string;
	summary: string;
	text: string;
}

const CHECK_TITLE = "glance landing-rail receipt";

/** GitHub's Checks API hard cap on `output.summary`/`output.text`, enforced IN BYTES (a multi-byte
 *  character counts against the byte limit, not the visible character count) — R1's evidence list,
 *  github/docs#2403 + safe-settings#493. */
const MAX_OUTPUT_BYTES = 65_535;

/** Truncate at a UTF-8 byte boundary and say so — never silently drop content without a marker, and
 *  never exceed GitHub's cap (which GitHub would otherwise reject the whole check-run creation for). */
function truncateUtf8(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.byteLength <= maxBytes) return s;
	const suffix = "\n\n… (receipt truncated to fit GitHub's check-run output size limit)";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	return buf.subarray(0, Math.max(0, maxBytes - suffixBytes)).toString("utf8") + suffix;
}

/** The success path: an agent-authored PR WITH a landing-rail receipt. `output.text` carries the
 *  full T6 receipt comment; `output.summary` is its own first line (the honest verdict, already
 *  formed by render-comment.ts — never re-derived). */
export function receiptToCheckOutput(receipt: LandReceipt): CheckRunOutput {
	const commentMd = renderReceiptComment(receipt);
	const summary = commentMd.split("\n", 1)[0].replace(/^###\s*/, "");
	return {
		title: CHECK_TITLE,
		summary: truncateUtf8(summary, MAX_OUTPUT_BYTES),
		text: truncateUtf8(commentMd, MAX_OUTPUT_BYTES),
	};
}

/** The gate path: an agent-authored PR classified by authorship.ts but WITHOUT a receipt for its head
 *  SHA. `pr.authorLogin` / `pr.headRef` are attacker-influenceable (a PR author picks their own login
 *  name and branch name), so they're `mdEsc`'d the same as any other agent-authored string landing on
 *  this trust surface (T6's own discipline — see render-comment.ts's TRUST BOUNDARY comment). */
export function noReceiptOutput(pr: PullRequestInfo, authorship: AuthorshipVerdict): CheckRunOutput {
	const summary = "❌ **No glance receipt found** — this PR looks agent-authored and landing-rail has no verified receipt for its head commit.";
	const text = [
		"This PR was classified as agent-authored by the glance GitHub-App wedge, but no landing-rail receipt exists for its current head commit.",
		"A glance land receipt proves the change passed the acceptance gate and an independent validator before merge — land the change through glance's landing-rail pipeline to produce one, or push a new commit once it has.",
		"",
		"<details><summary>Why this PR was gated</summary>",
		"",
		`- author login: \`${mdEsc(pr.authorLogin || "(none)")}\``,
		`- head branch: \`${mdEsc(pr.headRef)}\``,
		`- authorship signal: ${mdEsc(authorship.signal)} — ${mdEsc(authorship.detail)}`,
		`- head SHA: \`${pr.headSha}\``,
		"",
		"</details>",
	].join("\n");
	return { title: CHECK_TITLE, summary, text: truncateUtf8(text, MAX_OUTPUT_BYTES) };
}
