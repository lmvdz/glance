/**
 * The receipt renderer (glance#334, rail T6) — a PURE function from `LandReceipt` facts to a single
 * self-contained HTML string. No fs, no network, no daemon: golden-testable, and the string it returns
 * is the whole document (every byte of CSS inlined, no external fetch of any kind — CSP-safe by
 * construction).
 *
 * This is the product surface: the artifact a human approves INSTEAD of reading a 400-line diff. Taste
 * rules it follows (frontend-design-guidelines / artifact-design):
 *   - Typography carries it. One measured column, a type scale, generous space. Minimal apparatus —
 *     no chrome that doesn't answer a question.
 *   - Honest state is encoded in FORM, not just words: a failed gate paints the verdict band RED and
 *     the failure rows red; a red-baseline land is AMBER (landed, but main isn't green); a clean land
 *     is green. You can read the outcome before you read a word.
 *   - Theme-aware: light + dark via prefers-color-scheme, with a `data-theme` attribute override that
 *     wins in BOTH directions (so a host toggle beats the OS default).
 *   - Responsive: relative units, a single column that never overflows; wide content (failure lists,
 *     file lists, long shas) scrolls inside its OWN container, never the page body.
 */

import type { LandReceipt, GateStatus, PanelVerdict } from "./types.ts";
import type { ReviewerPrecisionStamp } from "../../memory/index.ts";
import { renderReviewerPrecision } from "../../memory/index.ts";

/** HTML-escape for TEXT and ATTRIBUTE contexts (quotes included — escapeHtml in concern-tickets.ts
 *  omits them, unsafe for the attribute values this renderer emits). */
function esc(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Short 10-char sha for display; full sha is kept in a title attribute by the caller. Never throws. */
function shortSha(sha: string | undefined): string {
	return sha ? sha.slice(0, 10) : "";
}

/** Human timestamp (UTC, unambiguous) — a receipt is read later, so an absolute time beats "2h ago". */
function fmtTime(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "unknown time";
	return `${d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`;
}

/**
 * The verdict a human reads first. Word + tone; the tone drives the color via a `data-status` band
 * class. Honest: an untrusted "green" is not "landed", a red-baseline land says so.
 */
function verdictOf(r: LandReceipt): { word: string; tone: "ok" | "warn" | "bad"; sub: string } {
	// A forced verdict only applies to a land that actually MERGED (an override that merged without a
	// proof); a forced flag on a no-merge result is not a "Force-landed".
	if (r.forcedWithoutProof && r.landed) return { word: "Force-landed", tone: "warn", sub: "merged WITHOUT a passing proof — a human override" };
	switch (r.gate.status) {
		case "green":
			// A green gate that did NOT merge (the "no changes to land" path) never says "Landed/merged".
			return r.landed
				? { word: "Landed", tone: "ok", sub: "gates green — merged into main" }
				: { word: "Nothing to land", tone: "warn", sub: "gates green, but no change was merged" };
		case "red-baseline":
			return { word: "Landed on a red base", tone: "warn", sub: "no new failures, but main was not green" };
		case "no-gate":
			return r.landed
				? { word: "Landed", tone: "warn", sub: "no acceptance gate ran — nothing proved it" }
				: { word: "Nothing to land", tone: "warn", sub: "no change was merged" };
		case "unproven-rejected":
			return { word: "Rejected", tone: "bad", sub: "a green pass could not be trusted — main rolled back" };
		case "failed":
		default:
			return r.landed
				? { word: "Landed", tone: "warn", sub: "gate reported problems — review the detail" }
				: { word: "Rejected", tone: "bad", sub: "gate failed — nothing merged, main is unchanged" };
	}
}

/** A compact, HONEST reviewer-precision chip label, e.g. "codex · 75% (n=52)" or "codex · unmeasured
 *  (n=0)". Mirrors the ledger reader's honesty rules (never a fabricated/smoothed number). */
function precisionChip(stamp: ReviewerPrecisionStamp): { label: string; tone: "measured" | "unmeasured" } {
	if (stamp.unreadable || stamp.corrupt || stamp.n === 0 || stamp.survivedRate === undefined || !Number.isFinite(stamp.survivedRate)) {
		return { label: `${stamp.lineage} · unmeasured (n=${stamp.n})`, tone: "unmeasured" };
	}
	const pct = stamp.survivedRate * 100;
	const shown = pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
	return { label: `${stamp.lineage} · ${shown} (n=${stamp.n})${stamp.provisional ? " [prov]" : ""}`, tone: "measured" };
}

/** Forward-compatible read of a T5 panel off the validation record — the field isn't on
 *  ValidationRecord yet (T5 parked, glance#356). Returns the receipt's own `panel` when set, else a
 *  `panel` carried on the validation record if a future version attaches one. */
function readPanel(r: LandReceipt): PanelVerdict[] | undefined {
	if (r.panel?.length) return r.panel;
	const carried = (r.validation as { panel?: PanelVerdict[] } | undefined)?.panel;
	return carried?.length ? carried : undefined;
}

/** A labeled section block. `tone` optionally tints the left rule (used for the failure list). */
function section(label: string, body: string): string {
	return `<section class="block"><h2 class="block-label">${esc(label)}</h2>${body}</section>`;
}

function renderWhat(r: LandReceipt): string {
	// A land that merged but whose commit SHA couldn't be attributed (the PR-scoped merge-commit read
	// failed) renders "unavailable" — honest — never a wrong SHA, and distinct from a non-landed result's
	// "nothing merged". See land-pr.ts's PR-scoped landedCommit binding.
	const commit = r.commit
		? `<code class="sha" title="${esc(r.commit)}">${esc(shortSha(r.commit))}</code>`
		: r.landed
			? `<span class="muted" title="the change merged, but its commit SHA could not be attributed">unavailable</span>`
			: `<span class="muted">nothing merged</span>`;
	const loc =
		r.insertions !== undefined || r.deletions !== undefined
			? `<span class="loc"><span class="add">+${r.insertions ?? 0}</span> <span class="del">−${r.deletions ?? 0}</span></span>`
			: "";
	const fileCount = r.files.length;
	const fileList = fileCount
		? `<details class="files"><summary>${fileCount} file${fileCount === 1 ? "" : "s"}${loc ? " " + loc : ""}</summary><div class="scroll"><ul class="filelist">${r.files
				.map((f) => `<li><code>${esc(f)}</code></li>`)
				.join("")}</ul></div></details>`
		: `<p class="muted">no files recorded${loc ? " " + loc : ""}</p>`;
	const messageRow = r.message ? `<div><dt>message</dt><dd>${esc(r.message)}</dd></div>` : "";
	return section(
		"What landed",
		`<dl class="kv">
			<div><dt>branch</dt><dd><code>${esc(r.branch)}</code></dd></div>
			<div><dt>repo</dt><dd><code>${esc(r.repo)}</code></dd></div>
			<div><dt>commit</dt><dd>${commit}</dd></div>
			${messageRow}
		</dl>${fileList}`,
	);
}

function renderProof(r: LandReceipt): string {
	const g = r.gate;
	const rows: string[] = [];
	const gateWord =
		g.status === "green"
			? `<span class="pill ok">gates green</span>`
			: g.status === "red-baseline"
				? `<span class="pill warn">landed on red baseline</span>`
				: g.status === "unproven-rejected"
					? `<span class="pill bad">unproven pass rejected</span>`
					: g.status === "no-gate"
						? `<span class="pill warn">no acceptance gate</span>`
						: `<span class="pill bad">gate failed</span>`;
	rows.push(`<div><dt>gate</dt><dd>${gateWord}${g.command ? ` <code class="muted">${esc(g.command)}</code>` : ""}</dd></div>`);
	rows.push(
		`<div><dt>unproven-green</dt><dd>${
			g.unprovenGreenRejected
				? `<span class="pill bad">rejected — a pass that couldn't be trusted</span>`
				: `<span class="ok-text">not accepted blindly</span>`
		}</dd></div>`,
	);
	const fs =
		g.newRegressions.length > 0
			? `<div class="scroll"><ul class="failures">${g.newRegressions.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul></div>`
			: g.baseWasRed
				? `<span class="ok-text">no new failures vs the (already red) baseline</span>`
				: `<span class="ok-text">no new failures vs baseline</span>`;
	rows.push(`<div><dt>failure-set diff</dt><dd>${fs}</dd></div>`);
	const detail = g.detail ? `<p class="detail scroll"><code>${esc(g.detail)}</code></p>` : "";
	return section("What proved it", `<dl class="kv">${rows.join("")}</dl>${detail}`);
}

function renderReviewer(r: LandReceipt): string {
	const v = r.validation;
	if (!v) {
		return section("Who reviewed it", `<p class="muted">no independent validator ran (no declared criteria to grade).</p>`);
	}
	const verdictTone = v.verdict === "pass" ? "ok" : v.verdict === "veto" ? "bad" : "warn";
	const parts: string[] = [];
	parts.push(
		`<div><dt>verdict</dt><dd><span class="pill ${verdictTone}">${esc(v.verdict)}</span> <span class="muted">${Math.round(
			v.agreement * 100,
		)}% of criteria satisfied</span></dd></div>`,
	);
	const lineage = v.model ? esc(v.model) : "unknown";
	if (v.reviewerPrecision) {
		const chip = precisionChip(v.reviewerPrecision);
		parts.push(
			`<div><dt>reviewer</dt><dd><span class="chip ${chip.tone}" title="${esc(
				renderReviewerPrecision(v.reviewerPrecision),
			)}">${esc(chip.label)}</span></dd></div>`,
		);
	} else {
		parts.push(`<div><dt>reviewer</dt><dd><code>${lineage}</code> <span class="muted">precision unmeasured</span></dd></div>`);
	}
	if (v.sameLineage === true) {
		parts.push(
			`<div><dt>lineage</dt><dd><span class="pill warn">same-lineage review</span> <span class="muted">author &amp; judge share a vendor — a weaker signal</span></dd></div>`,
		);
	}
	const rationale = v.rationale ? `<p class="detail scroll"><code>${esc(v.rationale)}</code></p>` : "";
	// Per-criterion notes — the reviewer's WHY at the finest grain (a reviewer's reasoning is core
	// receipt content, not a diff detail). Only criteria that carry a note; unmet ones flagged red.
	const noted = v.perCriterion?.filter((c) => c.note && c.note.trim()) ?? [];
	const notes = noted.length
		? `<ul class="criteria scroll">${noted
				.map(
					(c) =>
						`<li class="${c.satisfied ? "" : "unmet"}"><code>${esc(c.id)}</code>${c.satisfied ? "" : ' <span class="pill bad">unmet</span>'} <span class="muted">${esc(
							c.note ?? "",
						)}</span></li>`,
				)
				.join("")}</ul>`
		: "";
	return section("Who reviewed it", `<dl class="kv">${parts.join("")}</dl>${rationale}${notes}` + renderPanel(r));
}

/** The T5 (parked) panel section — rendered ONLY when a panel is present; omitted with zero trace
 *  otherwise, so the surface reads clean today and gains a section for free when T5 lands. */
function renderPanel(r: LandReceipt): string {
	const panel = readPanel(r);
	if (!panel) return "";
	const rows = panel
		.map((p) => {
			const tone = p.verdict === "approve" ? "ok" : p.verdict === "object" ? "bad" : "warn";
			const prec = p.precision ? ` <span class="chip ${precisionChip(p.precision).tone}">${esc(precisionChip(p.precision).label)}</span>` : "";
			const note = p.note ? ` <span class="muted">${esc(p.note)}</span>` : "";
			return `<li><span class="pill ${tone}">${esc(p.verdict)}</span> <code>${esc(p.reviewer)}</code>${prec}${note}</li>`;
		})
		.join("");
	return `<div class="panel"><h3 class="block-label">Review panel</h3><ul class="panel-list">${rows}</ul></div>`;
}

function renderRollback(r: LandReceipt): string {
	const body = r.rollbackPoint
		? `<dl class="kv"><div><dt>revert to</dt><dd><code class="sha" title="${esc(r.rollbackPoint)}">${esc(
				shortSha(r.rollbackPoint),
			)}</code> <span class="muted">main returns here if reverted</span></dd></div></dl>`
		: `<p class="muted">nothing merged — no rollback needed.</p>`;
	const forced = r.forcedWithoutProof
		? `<p class="detail"><span class="pill warn">forced</span> merged without a passing proof gate — this land is an override on record.</p>`
		: "";
	return section("Rollback point", body + forced);
}

function renderCost(r: LandReceipt): string {
	const c = r.cost;
	let costHtml: string;
	if (c.costUnknown) {
		costHtml = `<span class="cost unattributed" title="no assistant usage was observed for this run">cost unattributed</span>`;
	} else {
		const usd = c.costUsd ?? 0;
		costHtml = `<span class="cost">$${usd.toFixed(usd < 1 ? 4 : 2)}</span>`;
	}
	const meta: string[] = [];
	if (c.model) meta.push(`<code>${esc(c.model)}</code>`);
	if (c.tokens !== undefined) meta.push(`${c.tokens.toLocaleString("en-US")} tokens`);
	const metaHtml = meta.length ? ` <span class="muted">${meta.join(" · ")}</span>` : "";
	return section("Cost", `<p class="costline">${costHtml}${metaHtml}</p>`);
}

/**
 * Render the full self-contained HTML receipt. The returned string is a complete document body under
 * a `<!doctype html>` wrapper the caller writes; here we emit `<html>…</html>` in full so the file
 * stands alone when opened directly from disk.
 */
export function renderReceiptHtml(r: LandReceipt): string {
	const verdict = verdictOf(r);
	const title = `Land receipt — ${r.branch}`;
	return `<!doctype html>
<html lang="en" data-status="${verdict.tone}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="receipt">
	<header class="head">
		<p class="eyebrow">glance · land receipt</p>
		<h1 class="title"><code>${esc(r.branch)}</code></h1>
		<p class="meta"><code>${esc(r.repo)}</code> · ${esc(fmtTime(r.at))}</p>
	</header>
	<div class="verdict verdict-${verdict.tone}" role="status">
		<span class="verdict-word">${esc(verdict.word)}</span>
		<span class="verdict-sub">${esc(verdict.sub)}</span>
	</div>
	${renderWhat(r)}
	${renderProof(r)}
	${renderReviewer(r)}
	${renderRollback(r)}
	${renderCost(r)}
	<footer class="foot">
		<p>Generated by glance rail. Every fact above is read from the land's own record — no number is fabricated. A blank field means the land recorded nothing there, not that the answer is zero.</p>
	</footer>
</main>
</body>
</html>`;
}

/**
 * All styling, inlined. Theme-aware: light defaults, dark via `prefers-color-scheme`, and a
 * `:root[data-theme]` override that wins in both directions. Verdict tone drives the band + accents
 * off `[data-status]` on the root.
 */
const STYLE = `
:root {
	color-scheme: light dark;
	--bg: #f7f7f5; --panel: #ffffff; --ink: #1a1a17; --muted: #6b6b63; --line: #e4e4de;
	--ok: #1f7a3d; --ok-bg: #e8f5ec; --warn: #8a5a00; --warn-bg: #fbf1dd; --bad: #b3261e; --bad-bg: #fbe9e7;
	--accent: var(--ok);
	--mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
	--sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131311; --panel: #1c1c19; --ink: #ecece7; --muted: #9a9a90; --line: #2c2c28;
		--ok: #5ec97e; --ok-bg: #14301d; --warn: #e0a83a; --warn-bg: #322612; --bad: #f2675c; --bad-bg: #3a1614;
	}
}
:root[data-theme="light"] {
	--bg: #f7f7f5; --panel: #ffffff; --ink: #1a1a17; --muted: #6b6b63; --line: #e4e4de;
	--ok: #1f7a3d; --ok-bg: #e8f5ec; --warn: #8a5a00; --warn-bg: #fbf1dd; --bad: #b3261e; --bad-bg: #fbe9e7;
}
:root[data-theme="dark"] {
	--bg: #131311; --panel: #1c1c19; --ink: #ecece7; --muted: #9a9a90; --line: #2c2c28;
	--ok: #5ec97e; --ok-bg: #14301d; --warn: #e0a83a; --warn-bg: #322612; --bad: #f2675c; --bad-bg: #3a1614;
}
:root[data-status="ok"] { --accent: var(--ok); }
:root[data-status="warn"] { --accent: var(--warn); }
:root[data-status="bad"] { --accent: var(--bad); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.5;
	-webkit-font-smoothing: antialiased; padding: clamp(1rem, 4vw, 3rem) 1rem; }
.receipt { max-width: 44rem; margin: 0 auto; }
code { font-family: var(--mono); font-size: 0.92em; }
.head { margin-bottom: 1.5rem; }
.eyebrow { font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.7rem;
	color: var(--muted); margin: 0 0 0.6rem; }
.title { font-size: clamp(1.4rem, 4vw, 2rem); margin: 0; font-weight: 650; letter-spacing: -0.01em; word-break: break-word; }
.title code { font-size: inherit; }
.meta { color: var(--muted); font-size: 0.85rem; margin: 0.4rem 0 0; word-break: break-word; }
.verdict { display: flex; flex-direction: column; gap: 0.15rem; padding: 1rem 1.2rem; border-radius: 0.7rem;
	border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); background: var(--panel);
	border-left: 4px solid var(--accent); margin-bottom: 1.75rem; }
.verdict-word { font-size: 1.25rem; font-weight: 680; color: var(--accent); }
.verdict-sub { color: var(--muted); font-size: 0.9rem; }
.block { background: var(--panel); border: 1px solid var(--line); border-radius: 0.7rem;
	padding: 1.1rem 1.2rem; margin-bottom: 1rem; }
.block-label { font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem;
	color: var(--muted); margin: 0 0 0.8rem; font-weight: 600; }
.kv { margin: 0; display: grid; gap: 0.55rem; }
.kv > div { display: grid; grid-template-columns: 8.5rem 1fr; gap: 0.5rem 1rem; align-items: baseline; }
@media (max-width: 30rem) { .kv > div { grid-template-columns: 1fr; gap: 0.15rem; } }
.kv dt { font-family: var(--mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
	color: var(--muted); margin: 0; }
.kv dd { margin: 0; word-break: break-word; }
.sha { background: color-mix(in srgb, var(--ink) 7%, transparent); padding: 0.1rem 0.4rem; border-radius: 0.3rem; }
.muted { color: var(--muted); }
.ok-text { color: var(--ok); }
.loc { font-family: var(--mono); font-size: 0.85em; }
.add { color: var(--ok); } .del { color: var(--bad); }
.pill { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 0.12rem 0.5rem; border-radius: 999px;
	border: 1px solid transparent; white-space: nowrap; }
.pill.ok { color: var(--ok); background: var(--ok-bg); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.pill.warn { color: var(--warn); background: var(--warn-bg); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.pill.bad { color: var(--bad); background: var(--bad-bg); border-color: color-mix(in srgb, var(--bad) 30%, transparent); }
.chip { display: inline-block; font-family: var(--mono); font-size: 0.78rem; padding: 0.12rem 0.5rem; border-radius: 0.4rem;
	border: 1px solid var(--line); }
.chip.measured { color: var(--ink); background: color-mix(in srgb, var(--ok) 12%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.chip.unmeasured { color: var(--muted); background: color-mix(in srgb, var(--muted) 10%, transparent); }
.files, .detail { margin-top: 0.8rem; }
.files summary { cursor: pointer; font-size: 0.85rem; color: var(--muted); }
.filelist, .failures, .panel-list { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.3rem; }
.filelist li, .failures li { font-size: 0.85rem; }
.failures li { color: var(--bad); }
.failures li code { color: var(--bad); }
.criteria { list-style: none; margin: 0.7rem 0 0; padding: 0; display: grid; gap: 0.35rem; }
.criteria li { font-size: 0.82rem; }
.criteria li.unmet code { color: var(--bad); }
.scroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; }
.detail { background: color-mix(in srgb, var(--ink) 4%, transparent); border-radius: 0.4rem; padding: 0.6rem 0.75rem; }
.detail code { white-space: pre-wrap; word-break: break-word; font-size: 0.8rem; color: var(--muted); }
.panel { margin-top: 1rem; padding-top: 0.9rem; border-top: 1px dashed var(--line); }
.panel-list li { font-size: 0.85rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.costline { margin: 0; font-size: 1.05rem; }
.cost { font-family: var(--mono); font-weight: 650; }
.cost.unattributed { color: var(--warn); font-weight: 600; font-size: 0.95rem; }
.foot { margin-top: 1.5rem; }
.foot p { color: var(--muted); font-size: 0.75rem; line-height: 1.5; margin: 0; }
`;
