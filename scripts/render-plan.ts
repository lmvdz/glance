/**
 * Render a plans/<name>/ directory as a reviewable HTML page.
 *
 * Plan docs are a real format — 339 concerns across this repo share the same frontmatter keys and
 * section headings — so this renders the STRUCTURE rather than just prettifying markdown. What a
 * reader gets that `cat`-ing eight files does not give them:
 *
 *   - progress as a shape, not a number you compute by grepping STATUS
 *   - status and priority encoded in form (pill, stripe) so state reads at a glance
 *   - the dependency graph drawn, instead of BLOCKED_BY lines to hold in your head
 *   - which concerns are ACTIONABLE RIGHT NOW — open, and every blocker already done
 *
 * That last one is the question a plan actually gets opened to answer, and it is the one thing the
 * raw files cannot show you.
 *
 * Usage:  bun scripts/render-plan.ts plans/<name> [out.html]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface Concern {
	file: string;
	num: string;
	title: string;
	fields: Record<string, string>;
	sections: Record<string, string>;
}

const FIELD = /^([A-Z_]+):\s*(.*)$/;

export function parseConcern(file: string, raw: string): Concern {
	const lines = raw.split("\n");
	const title = (lines[0] ?? "").replace(/^#\s*/, "").trim();
	const fields: Record<string, string> = {};
	const sections: Record<string, string> = {};
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.trim()) continue;
		const m = FIELD.exec(line);
		if (m) fields[m[1]!] = m[2]!.trim();
		else break;
	}
	let current = "";
	let buf: string[] = [];
	const flush = () => { if (current) sections[current] = buf.join("\n").trim(); buf = []; };
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith("## ")) { flush(); current = line.slice(3).trim(); }
		else buf.push(line);
	}
	flush();
	return { file, num: (path.basename(file).match(/^(\d+)/) ?? [, "--"])[1]!, title, fields, sections };
}

/** Minimal markdown for the subset plan docs actually use. Deliberately not a full parser. */
function md(src: string): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const inline = (s: string) =>
		esc(s)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
	const out: string[] = [];
	let list: string[] = [];
	let table: string[][] = [];
	const flushList = () => { if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = []; } };
	const flushTable = () => {
		if (!table.length) return;
		const [head, ...body] = table;
		out.push(
			`<div class="scroll"><table><thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
			`<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
		);
		table = [];
	};
	for (const line of src.split("\n")) {
		const t = line.trim();
		if (/^\|.*\|$/.test(t)) {
			const cells = t.slice(1, -1).split("|").map((c) => c.trim());
			if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
			table.push(cells);
			continue;
		}
		flushTable();
		if (/^[-*]\s+/.test(t)) { list.push(t.replace(/^[-*]\s+/, "")); continue; }
		if (/^\d+\.\s+/.test(t)) { list.push(t.replace(/^\d+\.\s+/, "")); continue; }
		flushList();
		if (!t) continue;
		if (t.startsWith("### ")) { out.push(`<h4>${inline(t.slice(4))}</h4>`); continue; }
		out.push(`<p>${inline(t)}</p>`);
	}
	flushList();
	flushTable();
	return out.join("\n");
}

const STATUS_TONE: Record<string, string> = { done: "done", open: "open", blocked: "blocked", cancelled: "cancelled" };

/** The structural read of a plan directory, shared by the HTML renderer and `--json`.
 *  Exported so a distillation pass (`/distill-plan`) consumes the SAME parsed structure the
 *  renderer draws, instead of re-deriving status/blocker/actionable logic and drifting from it. */
export interface PlanStructure {
	plan: string;
	overview?: Concern;
	items: Concern[];
	total: number;
	done: number;
	/** Open, with every blocker already done — the question a plan is actually opened to answer. */
	actionable: Concern[];
	/** Per concern: the blockers that are NOT yet done. */
	blockedBy: Record<string, string[]>;
}

export async function readPlan(dir: string): Promise<PlanStructure> {
	const names = (await fs.readdir(dir)).filter((n) => /^\d+.*\.md$/.test(n)).sort();
	const concerns: Concern[] = [];
	for (const n of names) concerns.push(parseConcern(n, await fs.readFile(path.join(dir, n), "utf8")));
	const overview = concerns.find((c) => c.num === "00");
	const items = concerns.filter((c) => c.num !== "00");
	const statusOf = (c: Concern) => (c.fields.STATUS ?? "open").toLowerCase();
	const doneNums = new Set(items.filter((c) => statusOf(c) === "done").map((c) => c.num));
	const blockers = (c: Concern) => (c.fields.BLOCKED_BY ?? "").split(",").map((x) => x.trim().padStart(2, "0")).filter((x) => x && x !== "00");
	const blockedBy: Record<string, string[]> = {};
	for (const c of items) blockedBy[c.num] = blockers(c).filter((b) => !doneNums.has(b));
	return {
		plan: path.basename(dir),
		overview,
		items,
		total: items.length,
		done: items.filter((c) => statusOf(c) === "done").length,
		actionable: items.filter((c) => statusOf(c) === "open" && blockers(c).every((b) => doneNums.has(b))),
		blockedBy,
	};
}

async function main() {
	const argv = process.argv.slice(2).filter((a) => a !== "--json");
	const jsonMode = process.argv.includes("--json");
	const dir = argv[0];
	if (!dir) { console.error("usage: bun scripts/render-plan.ts plans/<name> [out.html] [--json]"); process.exit(1); }
	const structure = await readPlan(dir);
	// `--json` emits the parsed structure for a distillation pass (see .claude/skills/distill-plan):
	// same parser, same status/blocker/actionable logic the HTML renderer uses — one source of truth.
	if (jsonMode) { console.log(JSON.stringify(structure, null, 2)); return; }
	const out = argv[1] ?? path.join(dir, "plan.html");
	const { overview, items, total, done, actionable } = structure;
	const statusOf = (c: Concern) => (c.fields.STATUS ?? "open").toLowerCase();
	const doneNums = new Set(items.filter((c) => statusOf(c) === "done").map((c) => c.num));
	const blockers = (c: Concern) => (c.fields.BLOCKED_BY ?? "").split(",").map((s) => s.trim().padStart(2, "0")).filter((s) => s && s !== "00");

	const planName = structure.plan;
	const rendered = `<title>${planName} — plan review</title>
<style>
:root{
  --ink:#0A0A0B; --panel:#0C0C0E; --surface:#151517; --surface-2:#0F0F11;
  --border:#1C1C20; --border-2:#2A2A2E;
  --text:#F4F4F5; --body:#E7E7E9; --label:#C7C7CC; --muted:#8A8A90; --subtle:#5C5C62;
  --ember:#F0A35A; --ember-hi:#FFF6EA;
  --good:#4ADE80; --warn:#FBBF24; --crit:#F87171; --info:#38BDF8;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: light){:root{
  --ink:#FBFBFA; --panel:#FFFFFF; --surface:#F4F4F3; --surface-2:#EFEFEE;
  --border:#E3E3E1; --border-2:#D3D3D0;
  --text:#141416; --body:#26262A; --label:#44444A; --muted:#6E6E76; --subtle:#8E8E96;
  --ember:#B4701F; --ember-hi:#5A3708; --good:#15803D; --warn:#A16207; --crit:#B91C1C; --info:#0369A1;
}}
:root[data-theme="light"]{--ink:#FBFBFA;--panel:#FFFFFF;--surface:#F4F4F3;--surface-2:#EFEFEE;--border:#E3E3E1;--border-2:#D3D3D0;--text:#141416;--body:#26262A;--label:#44444A;--muted:#6E6E76;--subtle:#8E8E96;--ember:#B4701F;--ember-hi:#5A3708;--good:#15803D;--warn:#A16207;--crit:#B91C1C;--info:#0369A1}
:root[data-theme="dark"]{--ink:#0A0A0B;--panel:#0C0C0E;--surface:#151517;--surface-2:#0F0F11;--border:#1C1C20;--border-2:#2A2A2E;--text:#F4F4F5;--body:#E7E7E9;--label:#C7C7CC;--muted:#8A8A90;--subtle:#5C5C62;--ember:#F0A35A;--ember-hi:#FFF6EA;--good:#4ADE80;--warn:#FBBF24;--crit:#F87171;--info:#38BDF8}
body{background:var(--ink);color:var(--body);font-family:var(--sans);font-size:15px;line-height:1.62;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto;padding:clamp(26px,5vw,64px) clamp(16px,4vw,36px) 110px}
h1{font-size:clamp(27px,4.5vw,38px);line-height:1.1;letter-spacing:-.02em;font-weight:600;margin:0 0 14px;text-wrap:balance;color:var(--text)}
h2{font-size:20px;font-weight:600;letter-spacing:-.015em;margin:0 0 14px;color:var(--text);text-wrap:balance}
h3{font-size:15.5px;font-weight:600;margin:0;color:var(--text);letter-spacing:-.005em}
h4{font-size:13.5px;font-weight:600;margin:14px 0 6px;color:var(--label)}
p{margin:0 0 12px;max-width:70ch}
ul{margin:0 0 12px;padding-left:19px;max-width:70ch}li{margin-bottom:5px}
code{font-family:var(--mono);font-size:.86em;background:var(--surface);border:1px solid var(--border);padding:1px 5px;border-radius:3px;color:var(--label)}
a{color:var(--ember)}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--subtle);margin:0 0 9px}
.lede{color:var(--muted);font-size:16px;max-width:62ch;margin-bottom:20px}
.bar{display:flex;flex-wrap:wrap;gap:7px;margin:18px 0 0}
.pill{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;padding:4px 9px;border-radius:2px;border:1px solid var(--border-2);color:var(--muted);background:var(--panel);white-space:nowrap}
.pill.done{color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,transparent)}
.pill.open{color:var(--muted)}
.pill.blocked{color:var(--crit);border-color:color-mix(in srgb,var(--crit) 40%,transparent)}
.pill.cancelled{color:var(--subtle);text-decoration:line-through}
.pill.hot{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.progress{height:5px;border-radius:3px;background:var(--surface);overflow:hidden;margin:18px 0 6px;max-width:520px}
.progress i{display:block;height:100%;background:var(--good)}
.progress-label{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.05em}
section{margin-top:52px}
.rule{height:1px;background:var(--border);margin-bottom:22px}
.concern{border:1px solid var(--border);border-left:2px solid var(--border-2);border-radius:5px;background:var(--panel);padding:18px 20px;margin-bottom:14px}
.concern.is-done{border-left-color:var(--good)}
.concern.is-actionable{border-left-color:var(--ember)}
.concern.is-blocked{border-left-color:var(--border-2);opacity:.72}
.chead{display:flex;align-items:baseline;gap:11px;flex-wrap:wrap;margin-bottom:10px}
.cnum{font-family:var(--mono);font-size:12px;color:var(--subtle);font-variant-numeric:tabular-nums}
.cmeta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.cbody{font-size:14px;color:var(--muted)}
.cbody p,.cbody ul{max-width:76ch}
.cbody strong{color:var(--label)}
details{margin-top:10px;border-top:1px solid var(--border);padding-top:10px}
summary{cursor:pointer;font-family:var(--mono);font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--subtle);list-style:none}
summary::-webkit-details-marker{display:none}
summary:hover{color:var(--ember)}
.scroll{overflow-x:auto;border:1px solid var(--border);border-radius:4px;margin:12px 0;background:var(--panel)}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:13.5px}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--subtle);font-weight:500;background:var(--surface-2);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
.next{border:1px solid color-mix(in srgb,var(--ember) 35%,transparent);background:color-mix(in srgb,var(--ember) 7%,var(--panel));border-radius:5px;padding:18px 20px}
.next h2{color:var(--ember)}
.next ol{margin:0;padding-left:19px}
.next li{margin-bottom:6px;color:var(--label)}
.deps{font-family:var(--mono);font-size:12px;color:var(--muted)}
:focus-visible{outline:2px solid var(--ember);outline-offset:2px}
</style>
<div class="wrap">
<p class="eyebrow">Plan review · ${planName}</p>
<h1>${overview ? overview.title : planName}</h1>
${overview?.sections.Outcome ? `<div class="lede">${md(overview.sections.Outcome).replace(/<\/?p>/g, "")}</div>` : ""}
<div class="progress"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
<div class="progress-label">${done} of ${total} concerns done · ${actionable.length} actionable now</div>

${actionable.length ? `<section><div class="next"><h2>Actionable now</h2><p style="color:var(--muted);font-size:14px">Open, with every blocker already done.</p><ol>${actionable.map((c) => `<li><strong>${c.num}</strong> — ${c.title}</li>`).join("")}</ol></div></section>` : ""}

<section>
<p class="eyebrow">Concerns</p><div class="rule"></div>
${items.map((c) => {
	const st = statusOf(c);
	const blocked = blockers(c).filter((b) => !doneNums.has(b));
	const cls = st === "done" ? "is-done" : blocked.length ? "is-blocked" : st === "open" ? "is-actionable" : "";
	return `<article class="concern ${cls}">
  <div class="chead"><span class="cnum">${c.num}</span><h3>${c.title}</h3></div>
  <div class="cmeta">
    <span class="pill ${STATUS_TONE[st] ?? "open"}">${st}</span>
    ${c.fields.PRIORITY ? `<span class="pill">${c.fields.PRIORITY}</span>` : ""}
    ${c.fields.COMPLEXITY ? `<span class="pill">${c.fields.COMPLEXITY}</span>` : ""}
    ${c.fields.MODE === "hitl" ? `<span class="pill hot">needs a human</span>` : ""}
    ${blocked.length ? `<span class="pill blocked">blocked by ${blocked.join(", ")}</span>` : ""}
    ${c.fields.PLANE ? `<span class="pill">${c.fields.PLANE}</span>` : ""}
  </div>
  <div class="cbody">${md(c.sections.Goal ?? "")}</div>
  ${c.fields.TOUCHES ? `<p class="deps">touches ${c.fields.TOUCHES}</p>` : ""}
  ${c.sections.Approach ? `<details><summary>Approach</summary><div class="cbody">${md(c.sections.Approach)}</div></details>` : ""}
  ${c.sections.Verify ? `<details><summary>Verify</summary><div class="cbody">${md(c.sections.Verify)}</div></details>` : ""}
  ${c.sections.Resolution ? `<details><summary>Resolution</summary><div class="cbody">${md(c.sections.Resolution)}</div></details>` : ""}
</article>`;
}).join("\n")}
</section>

${overview ? Object.entries(overview.sections).filter(([k]) => !["Outcome", "Work"].includes(k)).map(([k, v]) => `<section><p class="eyebrow">${k}</p><div class="rule"></div><div class="cbody">${md(v)}</div></section>`).join("\n") : ""}
</div>`;

	await fs.writeFile(out, rendered);
	console.log(`rendered ${items.length} concerns → ${out}`);
	console.log(`  ${done}/${total} done · ${actionable.length} actionable now${actionable.length ? `: ${actionable.map((c) => c.num).join(", ")}` : ""}`);
}

// Guarded so `readPlan`/`parseConcern` can be imported (by tests and by any distillation pass)
// without the CLI firing on module load and exiting the importing process.
if (import.meta.main) void main();
