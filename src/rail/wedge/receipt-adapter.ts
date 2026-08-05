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
import type { ReceiptRejectReason, ReceiptVerifyResult } from "./receipt-verify.ts";

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

/** The gate path: an agent-authored PR classified by authorship.ts but WITHOUT any receipt to check —
 *  either none was ever supplied, or the one supplied was malformed (schema decode failed BEFORE this
 *  function is ever called; `malformedReason`, when set, replaces the generic "no receipt" wording
 *  with what specifically went wrong reading it). `pr.authorLogin` / `pr.headRef` are
 *  attacker-influenceable (a PR author picks their own login name and branch name), so they're
 *  `mdEsc`'d the same as any other agent-authored string landing on this trust surface (T6's own
 *  discipline — see render-comment.ts's TRUST BOUNDARY comment). */
export function noReceiptOutput(pr: PullRequestInfo, authorship: AuthorshipVerdict, malformedReason?: string): CheckRunOutput {
	const summary = malformedReason
		? "❌ **Malformed glance receipt** — the supplied receipt could not be read; treated as no receipt."
		: "❌ **No glance receipt found** — this PR looks agent-authored and landing-rail has no verified receipt for its head commit.";
	const text = [
		malformedReason
			? `This PR was classified as agent-authored by the glance GitHub-App wedge, and a receipt was supplied, but it could not be read: ${mdEsc(malformedReason)}`
			: "This PR was classified as agent-authored by the glance GitHub-App wedge, but no landing-rail receipt exists for its current head commit.",
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

/** A receipt WAS supplied and is well-formed, but FAILED verification against this PR (wrong
 *  repo/SHA, an unproven gate outcome, or staleness — see `verifyReceiptForPr`). Distinct from
 *  `noReceiptOutput`: something was submitted, it just doesn't check out — the summary says exactly
 *  why so an operator can tell "nothing submitted" from "the wrong thing was submitted" at a glance.
 *  Every receipt-derived string is `mdEsc`'d: a well-FORMED (schema-valid) receipt can still carry
 *  attacker-chosen free-text in `repo`/`commit`/`branch` (an operator-supplied JSON file, or a receipt
 *  copied from elsewhere), so it's exactly as untrusted as any other field on this surface. */
export function receiptRejectedOutput(receipt: LandReceipt, verify: Extract<ReceiptVerifyResult, { ok: false }>, pr: PullRequestInfo): CheckRunOutput {
	const reasonWord: Record<ReceiptRejectReason, string> = {
		"repo-mismatch": "wrong repo",
		"sha-mismatch": "wrong commit",
		"gate-not-proven": "gate not proven",
		stale: "stale",
	};
	const summary = `❌ **Glance receipt rejected** (${reasonWord[verify.reason]}) — ${mdEsc(verify.detail)}`;
	const text = [
		"A landing-rail receipt was supplied for this PR, but it failed verification and cannot green this check.",
		`Reason: **${reasonWord[verify.reason]}** — ${mdEsc(verify.detail)}`,
		"",
		"<details><summary>What the receipt claims vs. this PR</summary>",
		"",
		`- receipt repo: \`${mdEsc(receipt.repo)}\``,
		`- receipt commit: \`${mdEsc(receipt.commit ?? "(none — nothing merged)")}\``,
		`- receipt landed: ${receipt.landed ? "true" : "false"}`,
		`- receipt gate status: \`${mdEsc(receipt.gate.status)}\``,
		`- receipt forced-without-proof: ${receipt.forcedWithoutProof ? "true" : "false"}`,
		`- receipt timestamp: ${new Date(receipt.at).toISOString()}`,
		`- this PR's head SHA: \`${pr.headSha}\``,
		"",
		"</details>",
	].join("\n");
	return { title: CHECK_TITLE, summary, text: truncateUtf8(text, MAX_OUTPUT_BYTES) };
}

/** A PR that did NOT classify as agent-authored. Posted for EVERY such PR — never skipped — because a
 *  Ruleset's required-status-check applies to every PR update to the protected branch; a wedge that
 *  posts nothing for human PRs would block them outright (gauntlet round 1, both lineages HIGH: "gate
 *  only agent PRs" is not representable by a static Ruleset). This conclusion is `success` and says so
 *  PLAINLY as informational, not a real proof — never worded to look like a passed landing-rail check. */
export function notRequiredOutput(pr: PullRequestInfo, authorship: AuthorshipVerdict): CheckRunOutput {
	const summary = "▫️ **Not required** — human-authored PR, no landing-rail receipt required.";
	const text = [
		"This PR did not classify as agent-authored, so the glance GitHub-App wedge does not require a landing-rail receipt for it.",
		"This is an INFORMATIONAL pass, not a proof of anything about this change — it exists only so the repo's required-status-check Ruleset (which applies to every PR) doesn't block ordinary human-authored work.",
		"",
		"<details><summary>Authorship classification</summary>",
		"",
		`- author login: \`${mdEsc(pr.authorLogin || "(none)")}\``,
		`- head branch: \`${mdEsc(pr.headRef)}\``,
		`- signal: ${mdEsc(authorship.signal)} — ${mdEsc(authorship.detail)}`,
		"",
		"</details>",
	].join("\n");
	return { title: CHECK_TITLE, summary, text: truncateUtf8(text, MAX_OUTPUT_BYTES) };
}
