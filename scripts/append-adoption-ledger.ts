/**
 * Weekly adoption-ledger append (plans/daily-dogfood-engine/02) — fetch GET /api/adoption from the
 * running daemon and append ONE formatted row to `plans/daily-driver/00-meta.md`'s `## Ledger`.
 *
 * The FETCH is scripted (a script is more likely to actually run every week than a copy-paste
 * ritual), but invocation stays MANUAL — no cron, no daemon-side automation: the Ledger is
 * human-reviewed content, and daily-dogfood-engine 03 (drain cadence) owns *when* this runs.
 *
 * Fail-closed by design:
 *  - an unreachable daemon or a non-shape response EXITS 1 — it never appends a fabricated
 *    all-zero row (absence of evidence is not evidence of absence);
 *  - a meta file without a `## Ledger` section exits 1 untouched — the script inserts exactly one
 *    line inside the section it verified exists, never "somewhere".
 *
 *   bun scripts/append-adoption-ledger.ts [--port <N>] [--meta <path/to/00-meta.md>] [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { isAdoptionCounters, summarizeAdoption } from "../src/adoption-counters.ts";
import { base, parseArgs, tokenHeader } from "../src/cli-args.ts";

const { flags } = parseArgs(process.argv.slice(2));
const metaPath = typeof flags.meta === "string" ? path.resolve(flags.meta) : path.resolve("plans/daily-driver/00-meta.md");
const daemonBase = base(flags);

const fail = (msg: string): never => {
	console.error(`append-adoption-ledger: ${msg}`);
	process.exit(1);
};

// 1) Fetch the counters — from the daemon only. No local-file fallback here on purpose: the row
// this appends is a WEEKLY MEASUREMENT for the adoption gate, and quietly measuring a different
// state dir than the daemon writes to would poison the gate's evidence.
let counters: unknown;
try {
	const res = await fetch(`${daemonBase}/api/adoption`, { headers: tokenHeader(), signal: AbortSignal.timeout(5_000) });
	if (!res.ok) fail(`GET ${daemonBase}/api/adoption answered HTTP ${res.status} — no row appended`);
	counters = await res.json();
} catch (err) {
	fail(`daemon unreachable at ${daemonBase} (${err instanceof Error ? err.message : String(err)}) — no row appended; is it up? (glance up)`);
}
if (!isAdoptionCounters(counters)) fail("GET /api/adoption returned an unrecognized shape — is something else on this port? no row appended");

const s = summarizeAdoption(counters);
const row = `- ${s.day} — adoption counters (B02): last 7d ${s.sessions7} casual session(s) / ${s.prompts7} prompt(s) / ${s.pushTaps7} push tap(s); today ${s.sessions}/${s.prompts}/${s.pushTaps}.`;

// 2) Insert the row at the END of the `## Ledger` section (before the next `## ` heading, or at
// EOF when Ledger is last). Everything outside that one insertion point is byte-identical.
let text: string;
try {
	text = readFileSync(metaPath, "utf8");
} catch {
	fail(`cannot read ${metaPath}`);
}
const headingMatch = /^## Ledger[ \t]*$/m.exec(text);
if (!headingMatch) fail(`${metaPath} has no "## Ledger" section — refusing to append anywhere else`);
const sectionStart = headingMatch.index + headingMatch[0].length;
const nextHeading = text.slice(sectionStart).search(/^## /m);
const sectionEnd = nextHeading === -1 ? text.length : sectionStart + nextHeading;
// Trim trailing blank lines inside the section so the row lands right under the last entry.
const body = text.slice(sectionStart, sectionEnd).replace(/\s+$/, "");
const tail = text.slice(sectionEnd);
const updated = `${text.slice(0, sectionStart)}${body}\n${row}\n${nextHeading === -1 ? "" : "\n"}${tail}`;

if (flags["dry-run"]) {
	console.log(row);
	console.log(`(dry run — ${metaPath} unchanged)`);
} else {
	writeFileSync(metaPath, updated);
	console.log(`appended to ${metaPath}:\n${row}`);
}
