/**
 * Weekly drain triage-summary append (plans/daily-dogfood-engine/03) — append ONE status line to
 * `plans/daily-driver/00-meta.md`'s `## Ledger` recording what the weekly dogfood drain did with
 * the friction ledger: how many gripes were fixed on the spot, filed as concerns, and accepted.
 *
 * This is a STATUS line, not a verdict. The adoption gate's SUCCESS/KILL line is written only by
 * Lars, by hand, at the two-week gate review — this script rides src/meta-ledger.ts's
 * insertLedgerRow, which mechanically refuses verdict language, so no flag combination can make
 * it write one. Invocation is manual (step 5 of .claude/skills/dogfood-drain/SKILL.md); the
 * counts are typed in by whoever ran the triage, AFTER Lars approved it — a fabricated or
 * guessed zero would misstate the week, so every count flag is required, fail-closed.
 *
 *   bun scripts/append-drain-summary.ts --fixed <N> --filed <N> --accepted <N> \
 *     [--clusters "<repeat-pattern note>"] [--meta <path/to/00-meta.md>] [--dry-run]
 *
 * Exits 1 with the file untouched on: any missing/non-integer/negative count, verdict language
 * in --clusters, an unreadable meta file, or a meta file without a `## Ledger` section.
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { utcDayOf } from "../src/adoption-counters.ts";
import { parseArgs } from "../src/cli-args.ts";
import { insertLedgerRow } from "../src/meta-ledger.ts";

const { flags } = parseArgs(process.argv.slice(2));
const metaPath = typeof flags.meta === "string" ? path.resolve(flags.meta) : path.resolve("plans/daily-driver/00-meta.md");

const fail = (msg: string): never => {
	console.error(`append-drain-summary: ${msg}`);
	process.exit(1);
};

/** Required non-negative integer flag. A missing count is an error, never a silent 0 — the row
 *  is gate evidence, and a fabricated zero misstates the week's triage. */
const count = (name: "fixed" | "filed" | "accepted"): number => {
	const raw = flags[name];
	if (typeof raw !== "string") return fail(`--${name} <N> is required (0 is fine, but say so explicitly)`);
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) return fail(`--${name} must be a non-negative integer, got "${raw}"`);
	return n;
};

const fixed = count("fixed");
const filed = count("filed");
const accepted = count("accepted");
const total = fixed + filed + accepted;

let clusters = "";
if (flags.clusters !== undefined) {
	if (typeof flags.clusters !== "string" || !flags.clusters.trim()) fail("--clusters needs a non-empty note (or omit it)");
	clusters = (flags.clusters as string).trim();
	if (clusters.includes("\n")) fail("--clusters must be a single line");
}

const day = utcDayOf(Date.now());
const row =
	`- ${day} — weekly drain (B03): ${total} gripe(s) triaged — ${fixed} fixed now, ${filed} filed as concern(s), ${accepted} accepted` +
	`${clusters ? `; repeat-pattern cluster(s): ${clusters}` : ""}.`;

let text: string;
try {
	text = readFileSync(metaPath, "utf8");
} catch {
	text = fail(`cannot read ${metaPath}`);
}

let updated: string;
try {
	updated = insertLedgerRow(text, row);
} catch (err) {
	updated = fail(`${metaPath}: ${err instanceof Error ? err.message : String(err)}`);
}

if (flags["dry-run"]) {
	console.log(row);
	console.log(`(dry run — ${metaPath} unchanged)`);
} else {
	writeFileSync(metaPath, updated);
	console.log(`appended to ${metaPath}:\n${row}`);
}
