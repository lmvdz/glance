/**
 * The dogfood VERDICT-TABLE extractor (glance#392 item 3; format from G1 #385) — the read-side that
 * turns the rail's land-receipt index + self-land journal into the table the window's verdict ticket is
 * built from. It EXTRACTS facts; it never writes a verdict. #385 is explicit: "the campaign prepares
 * the table; Lars writes the verdict" — so this script emits NO pass/fail field, only the mechanically
 * checkable facts a human reads before deciding.
 *
 * What it extracts from `<stateDir>/land-receipts/index.jsonl` (+ the crash-safe finalized journal
 * rows the drain folds), scoped to a repo and a UTC-day window:
 *   - the routed-PR table: one row per land — day, branch, the receipt's landId/commit, MEASURED y/n,
 *     the validator verdict, the gate status, the per-lineage reviewer-precision stamp (lineage n +
 *     survived) captured at land time, and the criteria provenance (pr-body vs call).
 *   - per-gate counts: how many lands ended in each gate status (green / red-baseline / failed / …).
 *   - per-lineage precision: the latest measured stamp per reviewing lineage, and how many measured
 *     lands each lineage evaluated in the window — the "who reviewed, how well" summary.
 *   - the forced list: lands merged WITHOUT a passing proof (`forced:true`) — extractable from the
 *     index, each an honesty deduction #385 wants listed by name.
 *   - window validity FACTS ONLY: zero routed ⇒ invalid; unconfirmed (queued/pending) lands as a floor
 *     the operator must reconcile before the window closes. NO verdict field.
 *
 * NOT extractable from the index/journal (out of this script's honest reach — sourced elsewhere, said
 * so plainly rather than faked): the refusal log (gate-red events — the daemon audit log), and the
 * "landed outside the rail" list (a GitHub read of merges with no receipt).
 *
 * Fail-closed, mirroring append-selfland-drain: a MISSING index is an honest empty; any OTHER read
 * error (index or journal) EXITS 1 — an unmeasurable source must never read as a clean empty window.
 *
 *   bun scripts/selfland-verdict-table.ts [--state-dir <path>] [--repo owner/name] [--days N] [--json]
 */

import * as path from "node:path";
import { parseArgs } from "../src/cli-args.ts";
import { resolveStateDir } from "../src/state-dir.ts";
import { normalizeGitUrl } from "../src/repo-identity.ts";
import { readLandReceiptIndex, isMeasuredLand, landMetricsWindow, utcDayOf } from "../src/rail/land-metrics.ts";
import { journalRowsForWindow, unconfirmedSelfLands } from "../src/rail/self-land/journal.ts";
import type { LandReceiptIndexRow, GateStatus } from "../src/rail/receipt/types.ts";

const { flags } = parseArgs(process.argv.slice(2));
const stateDir = typeof flags["state-dir"] === "string" ? path.resolve(flags["state-dir"]) : resolveStateDir();
// The window's destination gate is two weeks (#362); default to 14 UTC days, overridable.
const days = typeof flags.days === "string" && Number.isFinite(Number(flags.days)) ? Math.max(1, Math.trunc(Number(flags.days))) : 14;
const rawRepo = typeof flags.repo === "string" && flags.repo.length > 0 ? flags.repo : undefined;
const repo = rawRepo ? normalizeGitUrl(rawRepo).split("/").slice(-2).join("/") : undefined;
const asJson = flags.json === true;

const fail = (msg: string): never => {
	console.error(`selfland-verdict-table: ${msg}`);
	process.exit(1);
};

// 1) Read the index (ENOENT ⇒ honest empty; any other error ⇒ fail-closed) and fold the crash-safe
// finalized journal rows, exactly as append-selfland-drain does, so a receipt whose index-append
// faulted after a confirmed merge is still in the table.
let read;
try {
	read = await readLandReceiptIndex(stateDir);
} catch (err) {
	fail(`cannot read the land-receipt index under ${stateDir} (${String(err)}) — the index is unmeasurable, not empty`);
}
const now = Date.now();
const untilDay = utcDayOf(now);
const sinceMs = now - (days - 1) * 86_400_000;
const sinceDay = utcDayOf(sinceMs);

let unconfirmedCount = 0;
try {
	const folded = await journalRowsForWindow(stateDir, read!.rows);
	if (folded.length) read = { rows: [...read!.rows, ...folded], malformed: read!.malformed };
	// Scope the unconfirmed floor to --repo AND the window (grok/codex gauntlet): the journal spans every
	// repo sharing the state dir, so an unfiltered count would let a stale queued land from ANOTHER repo
	// (or one outside this window) wrongly mark THIS scoped window `hasUnconfirmed`.
	const allUnconfirmed = await unconfirmedSelfLands(stateDir);
	unconfirmedCount = allUnconfirmed.filter((e) => (repo == null || e.repo === repo) && utcDayOf(e.at) >= sinceDay && utcDayOf(e.at) <= untilDay).length;
} catch (err) {
	fail(`cannot read the self-land journal under ${stateDir} (${String(err)}) — the measured-land fallback is unreadable; the table is unmeasurable, not empty`);
}

const w = landMetricsWindow(read!, days, now, repo);

// 2) The LANDED rows in the window (after the optional repo filter), for the routed-PR table. Only
// landed rows — a `landed:false` row is a rejected attempt, not a routed land, and must not populate a
// table whose totals (`w.lands`) count only lands, nor contradict the `zeroRouted` validity fact.
const inWindow = read!.rows
	.filter((r) => r.landed && (repo == null || r.repo === repo) && utcDayOf(r.at) >= sinceDay && utcDayOf(r.at) <= untilDay)
	.sort((a, b) => a.at - b.at);

interface VerdictRow {
	day: string;
	repo: string;
	branch: string;
	commit?: string;
	landId?: string;
	landed: boolean;
	forced: boolean;
	measured: boolean;
	verdict?: string;
	gateStatus: GateStatus;
	lineage?: string;
	precisionN?: number;
	precisionSurvived?: number;
	precisionFlag?: "corrupt" | "unreadable";
	criteriaSource?: "pr-body" | "call";
}

const rows: VerdictRow[] = inWindow.map((r: LandReceiptIndexRow) => ({
	day: utcDayOf(r.at),
	repo: r.repo,
	branch: r.branch,
	commit: r.commit,
	landId: r.landId,
	landed: r.landed,
	forced: r.forced,
	measured: isMeasuredLand(r),
	verdict: r.verdict,
	gateStatus: r.gateStatus,
	lineage: r.precision?.lineage,
	precisionN: r.precision?.n,
	precisionSurvived: r.precision?.survived,
	precisionFlag: r.precision?.corrupt ? "corrupt" : r.precision?.unreadable != null ? "unreadable" : undefined,
	criteriaSource: r.criteriaSource,
}));

// Per-gate counts (only landed rows — a non-landed row's gate status is a refusal, not a land outcome).
const perGate: Record<string, number> = {};
for (const r of rows) if (r.landed) perGate[r.gateStatus] = (perGate[r.gateStatus] ?? 0) + 1;

// Per-lineage summary: the LATEST measured stamp per reviewing lineage (its "current" precision) and
// how many measured lands it evaluated in the window. `n`/`survived` are ledger-wide adjudicated counts
// at stamp time — NOT additive across lands — so the summary reports the latest stamp, never a sum.
interface LineageSummary {
	lineage: string;
	measuredLands: number;
	latestN?: number;
	latestSurvived?: number;
	latestAt: number;
}
const lineageMap = new Map<string, LineageSummary>();
for (const r of inWindow) {
	const p = r.precision;
	// Only a MEASURED land contributes — both the count AND the "latest stamp". A precision-bearing but
	// unmeasured row (abstain, forced, corrupt/unreadable ledger) must never supply the displayed
	// "latest measured precision" (grok/codex gauntlet).
	if (!p || !isMeasuredLand(r)) continue;
	const cur = lineageMap.get(p.lineage) ?? { lineage: p.lineage, measuredLands: 0, latestAt: -1 };
	cur.measuredLands++;
	if (r.at >= cur.latestAt) {
		cur.latestAt = r.at;
		cur.latestN = p.n;
		cur.latestSurvived = p.survived;
	}
	lineageMap.set(p.lineage, cur);
}
const perLineage = [...lineageMap.values()].sort((a, b) => a.lineage.localeCompare(b.lineage));

// The forced list — merged WITHOUT a passing proof, an honesty deduction #385 lists by name.
const forced = rows.filter((r) => r.landed && r.forced);

const summary = {
	repo: repo ?? null,
	scoped: repo != null,
	window: { sinceDay: w.sinceDay, untilDay: w.untilDay, days: w.days },
	lands: w.lands,
	measured: w.measured,
	unmeasured: w.unmeasured,
	measuredDays: w.measuredDays,
	flagged: w.flagged,
	malformed: w.malformed,
	unconfirmed: unconfirmedCount,
	perGate,
	perLineage,
	forced: forced.map((f) => ({ branch: f.branch, commit: f.commit ?? null })),
	// Validity FACTS ONLY — no verdict (Lars writes that, #385).
	validity: {
		zeroRouted: w.lands === 0,
		hasUnconfirmed: unconfirmedCount > 0,
		hasForced: forced.length > 0,
		hasFlagged: w.flagged > 0,
		countIsFloor: w.malformed > 0,
	},
	rows,
};

if (asJson) {
	console.log(JSON.stringify(summary, null, 2));
	process.exit(0);
}

// Markdown output — the table the verdict ticket is assembled from (facts only, no verdict field).
const short = (s?: string): string => (s ? s.slice(0, 10) : "—");
const scopeLabel = repo ? `rail self-lands (${repo})` : "rail lands (ALL repos in this state dir — pass --repo to scope)";
const lines: string[] = [];
lines.push(`# Dogfood verdict table — ${scopeLabel}`);
lines.push("");
lines.push(`Window: ${w.sinceDay} .. ${w.untilDay} (${w.days} UTC days). Extracted ${utcDayOf(now)} from ${stateDir}.`);
lines.push("");
lines.push(`- lands: **${w.lands}** · measured: **${w.measured}** · unmeasured: **${w.unmeasured}** · measured days: **${w.measuredDays}/${w.days}**`);
lines.push(`- flagged (unreadable/corrupt ledger at land time): ${w.flagged} · malformed index lines: ${w.malformed}${w.malformed > 0 ? " (counts are a FLOOR)" : ""} · unconfirmed (queued/pending — reconcile first): ${unconfirmedCount}`);
lines.push("");

lines.push("## Routed-PR table");
lines.push("");
if (rows.length === 0) {
	lines.push("_No lands in the window._ (Zero routed ⇒ the window is INVALID as evidence — did the rail run? — not a clean pass.)");
} else {
	lines.push("| Day | Branch | Commit | Measured | Verdict | Gate | Reviewer precision | Criteria |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const r of rows) {
		const prec = r.lineage ? `${r.lineage} ${r.precisionSurvived ?? "?"}/${r.precisionN ?? "?"}${r.precisionFlag ? ` (${r.precisionFlag})` : ""}` : "—";
		lines.push(`| ${r.day} | ${r.branch} | \`${short(r.commit)}\` | ${r.measured ? "yes" : "no"}${r.forced ? " (forced)" : ""} | ${r.verdict ?? "—"} | ${r.gateStatus} | ${prec} | ${r.criteriaSource ?? "—"} |`);
	}
}
lines.push("");

lines.push("## Per-gate counts (landed rows)");
lines.push("");
const gateKeys = Object.keys(perGate);
if (gateKeys.length === 0) lines.push("_none_");
else for (const k of gateKeys.sort()) lines.push(`- ${k}: ${perGate[k]}`);
lines.push("");

lines.push("## Per-lineage reviewer precision (latest stamp in window)");
lines.push("");
if (perLineage.length === 0) lines.push("_No validator stamps in the window._");
else {
	lines.push("| Lineage | Measured lands | Latest precision (survived/n) |");
	lines.push("|---|---|---|");
	for (const l of perLineage) lines.push(`| ${l.lineage} | ${l.measuredLands} | ${l.latestSurvived ?? "?"}/${l.latestN ?? "?"} |`);
}
lines.push("");

lines.push("## Forced lands (no passing proof — honesty deductions)");
lines.push("");
if (forced.length === 0) lines.push("_none_");
else for (const f of forced) lines.push(`- ${f.branch} \`${short(f.commit)}\``);
lines.push("");

lines.push("## Window validity (facts only — the verdict is Lars's, #385)");
lines.push("");
lines.push(`- zero routed ⇒ invalid: ${summary.validity.zeroRouted ? "**YES — invalid**" : "no"}`);
lines.push(`- unconfirmed lands awaiting reconcile: ${summary.validity.hasUnconfirmed ? `**${unconfirmedCount}**` : "0"}`);
lines.push(`- forced lands in window: ${forced.length}`);
lines.push(`- flagged (untrusted ledger) lands: ${w.flagged}`);
lines.push(`- count is a floor (malformed lines): ${summary.validity.countIsFloor ? "yes" : "no"}`);
lines.push("");
lines.push("> Not extractable here (source elsewhere): the refusal log (daemon audit) and the landed-outside-the-rail list (a GitHub read). This table covers only what the index + journal can prove.");

console.log(lines.join("\n"));
