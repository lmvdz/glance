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
 *
 * GAUNTLET ROUND 2 (glance#337 PR #358, codex delta-verify CRITICAL): every function here now accepts
 * `authorship` and renders it as an EXPLICIT "informational only, does not affect this check's
 * conclusion" block. Round 1 had a THIRD output function (`notRequiredOutput`) that posted `success`
 * for a PR classified non-agent-authored — round 2 proved that `success` is Ruleset-indistinguishable
 * from a real verified one (same conclusion, same context, same integration_id; a Ruleset can't
 * predicate on `output.text`), so an agent posing as human — or simply avoiding the classification
 * signals — merged with NO receipt ever verified. `notRequiredOutput` is DELETED, not deprecated: gate
 * ALL PRs through the same `success`-requires-a-verified-receipt path, and render the authorship
 * classification as CONTEXT ONLY on whichever of the three real outcomes below actually happens.
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

/** The shared "authorship classification (informational only)" block appended to every output below.
 *  Rendered identically everywhere so a reader learns, once, that this line is CONTEXT and never the
 *  reason a check passed or failed. `signal`/`detail` derive from PR fields (login, branch, commit
 *  trailers) an author controls, so they're `mdEsc`'d like any other agent-authored string on this
 *  trust surface. Returns "" (nothing appended) when `authorship` is omitted. */
function authorshipBlock(authorship: AuthorshipVerdict | undefined, pr: PullRequestInfo | undefined): string {
	if (!authorship) return "";
	const lines = [
		"",
		"<details><summary>Authorship classification (informational only — never affects this check's conclusion)</summary>",
		"",
		`- agent-authored (classified): ${authorship.isAgentAuthored ? "yes" : "no"}`,
		`- signal: ${mdEsc(authorship.signal)} — ${mdEsc(authorship.detail)}`,
	];
	if (pr) lines.push(`- author login: \`${mdEsc(pr.authorLogin || "(none)")}\``, `- head branch: \`${mdEsc(pr.headRef)}\``);
	lines.push("", "</details>");
	return lines.join("\n");
}

/** The success path: a receipt VERIFIED against this PR (`verifyReceiptForPr`), for ANY PR regardless
 *  of authorship classification — round 2 gauntlet fix; `success` is never granted on classification
 *  alone. `output.text` carries the full T6 receipt comment plus the informational authorship block;
 *  `output.summary` is the receipt's own first line (the honest verdict, already formed by
 *  render-comment.ts — never re-derived), with a short "agent-authored: yes/no" tag appended. */
export function receiptToCheckOutput(receipt: LandReceipt, authorship?: AuthorshipVerdict): CheckRunOutput {
	const commentMd = renderReceiptComment(receipt);
	const firstLine = commentMd.split("\n", 1)[0].replace(/^###\s*/, "");
	const summary = authorship ? `${firstLine} · agent-authored: ${authorship.isAgentAuthored ? "yes" : "no"}` : firstLine;
	const text = commentMd + authorshipBlock(authorship, undefined);
	return {
		title: CHECK_TITLE,
		summary: truncateUtf8(summary, MAX_OUTPUT_BYTES),
		text: truncateUtf8(text, MAX_OUTPUT_BYTES),
	};
}

/** No receipt to check for this PR — either none was ever supplied, or the one supplied was malformed
 *  (schema decode failed BEFORE this function is ever called; `malformedReason`, when set, replaces
 *  the generic "no receipt" wording with what specifically went wrong reading it). Posted for EVERY
 *  such PR regardless of authorship classification (round 2 fix) — a repo gating on this wedge expects
 *  a receipt on every merge, not just agent-classified ones. `pr.authorLogin` / `pr.headRef` are
 *  attacker-influenceable (a PR author picks their own login name and branch name), so they're
 *  `mdEsc`'d the same as any other agent-authored string landing on this trust surface (T6's own
 *  discipline — see render-comment.ts's TRUST BOUNDARY comment). */
export function noReceiptOutput(pr: PullRequestInfo, authorship: AuthorshipVerdict, malformedReason?: string): CheckRunOutput {
	const summary = malformedReason
		? "❌ **Malformed glance receipt** — the supplied receipt could not be read; treated as no receipt."
		: "❌ **No glance receipt found** — this repo requires a verified landing-rail receipt on every PR; none exists for this head commit.";
	const text = [
		malformedReason
			? `A receipt was supplied for this PR, but it could not be read: ${mdEsc(malformedReason)}`
			: "No landing-rail receipt exists for this PR's current head commit.",
		"A glance land receipt proves the change passed the acceptance gate and an independent validator before merge — land the change through glance's landing-rail pipeline to produce one, or push a new commit once it has. This repo requires a verified receipt on EVERY pull request, not only ones classified agent-authored (see the authorship note below).",
		`- head SHA: \`${pr.headSha}\``,
		authorshipBlock(authorship, pr),
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
export function receiptRejectedOutput(receipt: LandReceipt, verify: Extract<ReceiptVerifyResult, { ok: false }>, pr: PullRequestInfo, authorship?: AuthorshipVerdict): CheckRunOutput {
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
		authorshipBlock(authorship, pr),
	].join("\n");
	return { title: CHECK_TITLE, summary, text: truncateUtf8(text, MAX_OUTPUT_BYTES) };
}
