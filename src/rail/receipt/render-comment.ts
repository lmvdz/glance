/**
 * The compact PR-comment renderer (glance#334, rail T6) — the at-a-glance version of the receipt for
 * the PR review UI. PURE (string in, string out): a small markdown block that answers the five
 * questions and links the full self-contained HTML receipt.
 *
 * TRUST BOUNDARY (gauntlet round 1, grok CRITICAL + codex HIGH): every field below is AGENT-AUTHORED
 * (a branch name, a test title, a model id, a validator rationale) and lands in a surface a HUMAN
 * TRUSTS to approve a merge. Unescaped, a crafted test title (a fence-close + `</details>`) or branch
 * (`x</sub><details>…`) forges a second "✅ Landed" verdict, hides the real one, or plants a phishing
 * link. So `mdEsc` neutralizes EVERY markdown/HTML control an agent string could use to break out of
 * its cell — the markdown-side mirror of render-html.ts's `esc`. The only content NOT passed through
 * it is this renderer's OWN literal structure (the verdict header, table pipes, `<details>` tags) and
 * values we mint ourselves (hex SHAs, counts).
 */

import type { LandReceipt } from "./types.ts";
import { renderReviewerPrecision } from "../../memory/index.ts";

/**
 * Neutralize an agent-authored string for BOTH markdown and inline-HTML contexts inside a comment:
 *   - newlines/CR → space (no new table rows, no breaking out to a top-level heading/list)
 *   - `<` `>` → entities (no structural `<details>`/`</sub>`/`<summary>` tags)
 *   - `|` → `\|` (no injected table columns)
 *   - backtick → entity (no inline-code, and no ```-fence close)
 *   - `[` `]` → entities (no `[label](url)` / `![img]()` disguised links)
 *   - `*` → entity (no `**bold**` forging a verdict-like emphasis inside a cell)
 * Everything else (parens, %, digits) is inert without those. `&` is escaped first so the entities
 * this inserts are themselves literal.
 */
export function mdEsc(s: string): string {
	return String(s)
		.replace(/\r\n?|\n/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\|/g, "\\|")
		.replace(/`/g, "&#96;")
		.replace(/\[/g, "&#91;")
		.replace(/\]/g, "&#93;")
		.replace(/\*/g, "&#42;")
		.trim();
}

/** A hex SHA we minted (or "—"); safe to wrap in backticks since it can hold no markdown. */
function short(sha: string | undefined): string {
	return sha ? `\`${sha.slice(0, 10)}\`` : "—";
}

/** Verdict glyph + word — the honest state at a glance. All literals (no agent input), so the header
 *  itself can never be forged. Consults `landed`: a green gate that did NOT merge is "nothing to land",
 *  never "Landed". */
function verdict(r: LandReceipt): string {
	if (r.forcedWithoutProof && r.landed) return "⚠️ **Force-landed** (no passing proof)";
	switch (r.gate.status) {
		case "green":
			return r.landed ? "✅ **Landed** — gates green" : "▫️ **Nothing to land** — gates green, no change merged";
		case "red-baseline":
			return "⚠️ **Landed on a red base** — no new failures, main not green";
		case "no-gate":
			return r.landed ? "⚠️ **Landed** — no acceptance gate ran" : "▫️ **Nothing to land** — no change merged";
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
	if (v.reviewerPrecision) return `${mdEsc(v.verdict)} · ${mdEsc(renderReviewerPrecision(v.reviewerPrecision))}`;
	return `${mdEsc(v.verdict)} · ${mdEsc(v.model ?? "unknown")} (precision unmeasured)`;
}

function costLine(r: LandReceipt): string {
	if (r.cost.costUnknown) return "cost unattributed";
	const usd = r.cost.costUsd ?? 0;
	const money = `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
	return r.cost.model ? `${money} (${mdEsc(r.cost.model)})` : money;
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
	bits.push(g.newRegressions.length > 0 ? `${g.newRegressions.length} new failure(s)` : "no new failures vs baseline");
	if (g.unprovenGreenRejected) bits.push("unproven-green rejected");
	return bits.join("; ");
}

export interface CommentOptions {
	/** A link to the full HTML receipt — a URL if hosted, or a local path a reader can open. */
	receiptHref?: string;
	/** How the href is presented: a real link, or a plain code-path. Defaults to "path". */
	hrefKind?: "url" | "path";
}

/** Render the href honestly: a path is shown as escaped inline text (never a link); a URL becomes a
 *  link ONLY if it is a well-formed http(s) URL, else it degrades to escaped text — a hostile
 *  `javascript:`/`data:`/malformed href never renders as a clickable link. */
function renderHref(opts: CommentOptions): string {
	if (!opts.receiptHref) return "";
	if (opts.hrefKind === "url") {
		const ok = /^https?:\/\/[^\s)]+$/i.test(opts.receiptHref);
		return ok ? `[open the full receipt](${opts.receiptHref})` : `full receipt: ${mdEsc(opts.receiptHref)}`;
	}
	return `full receipt: ${mdEsc(opts.receiptHref)}`;
}

/**
 * Render the compact PR comment. The verdict line is always visible; specifics live in the table and
 * expandable `<details>` blocks so the PR timeline stays tidy.
 */
export function renderReceiptComment(r: LandReceipt, opts: CommentOptions = {}): string {
	const files = `${r.files.length} file${r.files.length === 1 ? "" : "s"}`;
	const loc = r.insertions !== undefined || r.deletions !== undefined ? ` (+${r.insertions ?? 0} −${r.deletions ?? 0})` : "";
	const whatCell = r.commit ? `${short(r.commit)} · ${files}${loc}` : `nothing merged · ${files}${loc}`;
	const lines = [
		`### ${verdict(r)}`,
		"",
		`<sub>glance land receipt · ${mdEsc(r.branch)} → ${mdEsc(r.repo)}</sub>`,
		"",
		"| | |",
		"|---|---|",
		`| **What** | ${whatCell} |`,
	];
	if (r.message) lines.push(`| **Message** | ${mdEsc(r.message)} |`);
	lines.push(
		`| **Proved by** | ${proofLine(r)} |`,
		`| **Reviewed by** | ${reviewerLine(r)} |`,
		`| **Rollback to** | ${short(r.rollbackPoint)}${r.rollbackPoint ? "" : " (nothing merged)"} |`,
		`| **Cost** | ${costLine(r)} |`,
	);

	// New failures — escaped bullets inside <details>, never a raw ``` fence agent text could close.
	if (r.gate.newRegressions.length > 0) {
		lines.push("", `<details><summary>New failures vs baseline (${r.gate.newRegressions.length})</summary>`, "");
		for (const f of r.gate.newRegressions.slice(0, 20)) lines.push(`- ${mdEsc(f)}`);
		if (r.gate.newRegressions.length > 20) lines.push(`- … and ${r.gate.newRegressions.length - 20} more`);
		lines.push("</details>");
	}

	// The validator's WHY — rationale + any per-criterion notes (core receipt content, codex MEDIUM).
	const v = r.validation;
	const notes = v?.perCriterion?.filter((c) => c.note && c.note.trim()) ?? [];
	if ((v?.rationale && v.rationale.trim()) || notes.length > 0) {
		lines.push("", "<details><summary>Why (validator)</summary>", "");
		if (v?.rationale && v.rationale.trim()) lines.push(`- ${mdEsc(v.rationale)}`);
		for (const c of notes) lines.push(`- ${mdEsc(c.id)}${c.satisfied ? "" : " (unmet)"}: ${mdEsc(c.note ?? "")}`);
		lines.push("</details>");
	}

	// The landed files (codex MEDIUM — a count alone isn't a reviewable receipt).
	if (r.files.length > 0) {
		lines.push("", `<details><summary>Files (${r.files.length})</summary>`, "");
		for (const f of r.files.slice(0, 50)) lines.push(`- ${mdEsc(f)}`);
		if (r.files.length > 50) lines.push(`- … and ${r.files.length - 50} more`);
		lines.push("</details>");
	}

	const href = renderHref(opts);
	if (href) lines.push("", href);
	return lines.join("\n");
}
