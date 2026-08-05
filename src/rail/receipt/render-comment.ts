/**
 * The compact PR-comment renderer (glance#334, rail T6) — the at-a-glance version of the receipt for
 * the PR review UI. PURE (string in, string out): a <30-line markdown block that answers the five
 * questions and links the full self-contained HTML receipt.
 *
 * Kept deliberately small: a reviewer skims this in the PR timeline; the HTML is where they go to
 * approve. Same honesty rules as the HTML — "cost unattributed" not "$0", "unmeasured (n=0)" not a
 * fabricated precision, a red ❌ verdict when a gate failed.
 */

import type { LandReceipt } from "./types.ts";
import { renderReviewerPrecision } from "../../memory/index.ts";

function short(sha: string | undefined): string {
	return sha ? sha.slice(0, 10) : "—";
}

/** Verdict glyph + word — the honest state, at a glance, in the PR list. */
function verdict(r: LandReceipt): string {
	if (r.forcedWithoutProof) return "⚠️ **Force-landed** (no passing proof)";
	switch (r.gate.status) {
		case "green":
			return "✅ **Landed** — gates green";
		case "red-baseline":
			return "⚠️ **Landed on a red base** — no new failures, main not green";
		case "no-gate":
			return r.landed ? "⚠️ **Landed** — no acceptance gate ran" : "⚠️ **Not landed** — no gate";
		case "unproven-rejected":
			return "❌ **Rejected** — a green pass couldn't be trusted";
		case "failed":
		default:
			return r.landed ? "⚠️ **Landed** — gate reported problems" : "❌ **Rejected** — gate failed, nothing merged";
	}
}

function reviewerLine(r: LandReceipt): string {
	const v = r.validation;
	if (!v) return "no independent validator (no declared criteria)";
	const verdictWord = v.verdict;
	if (v.reviewerPrecision) return `${verdictWord} · ${renderReviewerPrecision(v.reviewerPrecision)}`;
	return `${verdictWord} · ${v.model ?? "unknown"} (precision unmeasured)`;
}

function costLine(r: LandReceipt): string {
	if (r.cost.costUnknown) return "cost unattributed";
	const usd = r.cost.costUsd ?? 0;
	const money = `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
	return r.cost.model ? `${money} (${r.cost.model})` : money;
}

function proofLine(r: LandReceipt): string {
	const g = r.gate;
	const bits: string[] = [];
	bits.push(
		g.status === "green"
			? "gates green"
			: g.status === "red-baseline"
				? "red baseline (no new failures)"
				: g.status === "unproven-rejected"
					? "unproven pass rejected"
					: g.status === "no-gate"
						? "no acceptance gate"
						: "gate failed",
	);
	if (g.newRegressions.length > 0) bits.push(`${g.newRegressions.length} new failure(s)`);
	else bits.push("no new failures vs baseline");
	if (g.unprovenGreenRejected) bits.push("unproven-green rejected");
	return bits.join("; ");
}

export interface CommentOptions {
	/** A link to the full HTML receipt — a URL if hosted, or a local path a reader can open. */
	receiptHref?: string;
	/** How the href is presented: a real link, or a plain code-path. Defaults to "path". */
	hrefKind?: "url" | "path";
}

/**
 * Render the compact PR comment. Uses a `<details>` block so the PR timeline stays tidy — the verdict
 * line is always visible; the specifics expand on demand.
 */
export function renderReceiptComment(r: LandReceipt, opts: CommentOptions = {}): string {
	const files = `${r.files.length} file${r.files.length === 1 ? "" : "s"}`;
	const loc = r.insertions !== undefined || r.deletions !== undefined ? ` (+${r.insertions ?? 0} −${r.deletions ?? 0})` : "";
	const link = opts.receiptHref
		? opts.hrefKind === "url"
			? `[open the full receipt](${opts.receiptHref})`
			: `full receipt: \`${opts.receiptHref}\``
		: "";
	const lines = [
		`### ${verdict(r)}`,
		"",
		`<sub>glance land receipt · \`${r.branch}\` → \`${r.repo}\`</sub>`,
		"",
		"| | |",
		"|---|---|",
		`| **What** | \`${short(r.commit)}\` · ${files}${loc} |`,
		`| **Proved by** | ${proofLine(r)} |`,
		`| **Reviewed by** | ${reviewerLine(r)} |`,
		`| **Rollback to** | \`${short(r.rollbackPoint)}\`${r.rollbackPoint ? "" : " (nothing merged)"} |`,
		`| **Cost** | ${costLine(r)} |`,
	];
	if (r.gate.newRegressions.length > 0) {
		lines.push("", "<details><summary>New failures vs baseline</summary>", "", "```");
		for (const f of r.gate.newRegressions.slice(0, 20)) lines.push(f);
		if (r.gate.newRegressions.length > 20) lines.push(`… and ${r.gate.newRegressions.length - 20} more`);
		lines.push("```", "</details>");
	}
	if (link) lines.push("", link);
	return lines.join("\n");
}
