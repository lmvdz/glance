/**
 * Weekly self-land drain (landing-rail #339, dogfood window) — read the land-receipt index the rail
 * writes at `<stateDir>/land-receipts/index.jsonl` and append ONE honest row to the campaign's
 * self-land ledger, surfacing how many of glance's own PRs the rail landed in the last 7 days WITH
 * measured reviewer precision. This is the evidence the 2-week destination gate reviews.
 *
 * Reads the index FILE directly (not a daemon /api round-trip): the receipts are local files the
 * daemon durably writes, so the state dir is the authoritative source and needs no live daemon.
 *
 * Fail-closed by design, and careful about the ONE distinction the whole campaign is about —
 * measured absence vs. unmeasurable:
 *  - a MISSING index (`ENOENT`) is a measured zero: the rail simply hasn't landed anything yet. That
 *    is honest evidence, so a "last 7d 0 land(s)" row IS appended (it is NOT a fabricated zero — the
 *    source was readable and genuinely empty).
 *  - any OTHER read error (permission, I/O) EXITS 1 without appending — an unreadable index is
 *    unmeasurable, and a zero row there would fabricate absence of evidence as evidence of absence.
 *  - malformed index lines never inflate or hide the count; when any are seen the row says the count
 *    is a floor.
 *  - a ledger file without a `## Ledger` section exits 1 untouched (insertLedgerRow, the shared write
 *    path that also refuses verdict language — the gate VERDICT is Lars's alone, #339).
 *
 *   bun scripts/append-selfland-drain.ts [--state-dir <path>] [--meta <ledger.md>] [--days N] [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "../src/cli-args.ts";
import { insertLedgerRow } from "../src/meta-ledger.ts";
import { resolveStateDir } from "../src/state-dir.ts";
import { readLandReceiptIndex, landMetricsWindow, utcDayOf } from "../src/rail/land-metrics.ts";

const { flags } = parseArgs(process.argv.slice(2));
const stateDir = typeof flags["state-dir"] === "string" ? path.resolve(flags["state-dir"]) : resolveStateDir();
const metaPath = typeof flags.meta === "string" ? path.resolve(flags.meta) : path.resolve("plans/landing-rail/self-land-ledger.md");
const days = typeof flags.days === "string" && Number.isFinite(Number(flags.days)) ? Math.max(1, Math.trunc(Number(flags.days))) : 7;

const fail = (msg: string): never => {
	console.error(`append-selfland-drain: ${msg}`);
	process.exit(1);
};

// 1) Read the index. ENOENT ⇒ honest empty (rail hasn't landed yet). Any other error ⇒ fail-closed.
let read;
try {
	read = await readLandReceiptIndex(stateDir);
} catch (err) {
	fail(`cannot read the land-receipt index under ${stateDir} (${err instanceof Error ? err.message : String(err)}) — no row appended; the index is unmeasurable, not empty`);
}

// The window ends "now" in UTC. Date.now() is intentional here (a CLI, not a resume-safe workflow
// script) and only sets the window's upper bound + the row's date stamp.
const now = Date.now();
const w = landMetricsWindow(read!, days, now);

const floor = w.malformed > 0 ? ` (floor — ${w.malformed} malformed index line(s) skipped)` : "";
const measuredClause = w.measured > 0
	? `${w.measured} citing measured reviewer precision across ${w.measuredDays} day(s)`
	: `0 citing measured reviewer precision`;
const row = `- ${utcDayOf(now)} — rail self-lands (dogfood #339): last ${days}d ${w.lands} land(s) through the rail, ${measuredClause}; ${w.unmeasured} unmeasured${floor}.`;

// 2) Insert into the ledger's `## Ledger` section (byte-identical everywhere else). insertLedgerRow
// throws if the section is absent — we do NOT auto-create it, so the append target is always a file a
// human set up for this purpose.
let text: string;
try {
	text = readFileSync(metaPath, "utf8");
} catch {
	fail(`cannot read ${metaPath} — create it with a "## Ledger" section first (see plans/landing-rail/); no row appended`);
}
let updated: string;
try {
	updated = insertLedgerRow(text!, row);
} catch (err) {
	updated = fail(`${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
}

if (flags["dry-run"]) {
	console.log(row);
	console.log(`(dry run — ${metaPath} unchanged; state dir ${stateDir})`);
} else {
	writeFileSync(metaPath, updated!);
	console.log(`appended to ${metaPath}:\n${row}`);
}
