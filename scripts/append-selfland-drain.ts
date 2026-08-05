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
 * `--repo owner/name` scopes the count to ONE repo so the row can honestly say "self-lands"; without
 * it the row counts every repo sharing the state dir and labels itself accordingly.
 *
 *   bun scripts/append-selfland-drain.ts [--state-dir <path>] [--repo owner/name] [--meta <ledger.md>] [--days N] [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "../src/cli-args.ts";
import { insertLedgerRow } from "../src/meta-ledger.ts";
import { resolveStateDir } from "../src/state-dir.ts";
import { normalizeGitUrl } from "../src/repo-identity.ts";
import { readLandReceiptIndex, landMetricsWindow, utcDayOf } from "../src/rail/land-metrics.ts";

const { flags } = parseArgs(process.argv.slice(2));
const stateDir = typeof flags["state-dir"] === "string" ? path.resolve(flags["state-dir"]) : resolveStateDir();
const metaPath = typeof flags.meta === "string" ? path.resolve(flags.meta) : path.resolve("plans/landing-rail/self-land-ledger.md");
const days = typeof flags.days === "string" && Number.isFinite(Number(flags.days)) ? Math.max(1, Math.trunc(Number(flags.days))) : 7;
// The self-vs-fleet filter (grok #361): a state dir can hold lands for MANY repos. Only when --repo is
// given can the row honestly say "self-lands"; without it the row counts ALL repos and says so.
// Normalize the flag through the SAME path the writer derives receipt.repo from
// (repoIdentity → normalizeGitUrl → last two segments), so `Lmvdz/Glance`, a trailing slash, a `.git`
// suffix, or a full URL all match the stored lowercase `owner/repo` slug instead of silently zeroing
// a real week (grok #361 R1). A bare `--repo` (no value) parses to boolean true → treated as absent.
const rawRepo = typeof flags.repo === "string" && flags.repo.length > 0 ? flags.repo : undefined;
const repo = rawRepo ? normalizeGitUrl(rawRepo).split("/").slice(-2).join("/") : undefined;

const fail = (msg: string): never => {
	console.error(`append-selfland-drain: ${msg}`);
	process.exit(1);
};

// 1a) Wrong-state-dir guard (grok #361 G1). A MISSING index file is an honest "no lands yet" ONLY when
// the state dir is genuinely a daemon state dir. Guard on a real DAEMON MARKER (daemon.lock or
// state.json — written on daemon start, long before any land), NOT on the land-receipts/ dir:
//  - guarding on land-receipts/ FALSE-NEGATIVED a correct virgin daemon that had started but never
//    landed (no receipts dir yet) → it could never record an honest week-0 "0 lands" row (grok G1b);
//  - and it FALSE-POSITIVED a wrong path where someone had `mkdir`'d land-receipts/ (grok G1a).
// A daemon marker is present exactly when a daemon has run here, and absent for a typo/empty path.
const daemonMarkers = ["daemon.lock", "state.json"];
if (!daemonMarkers.some((m) => existsSync(path.join(stateDir, m)))) {
	fail(`${stateDir} has no daemon marker (${daemonMarkers.join(" / ")}) — no daemon has run here. Point --state-dir at the daemon's state dir (is it the right one?); refusing to append a 0-land row from a path that isn't a daemon state dir`);
}

// 1b) Read the index. ENOENT ⇒ honest empty (dir exists, rail hasn't landed yet). Any other error ⇒
// fail-closed (unmeasurable, not empty).
let read;
try {
	read = await readLandReceiptIndex(stateDir);
} catch (err) {
	fail(`cannot read the land-receipt index under ${stateDir} (${err instanceof Error ? err.message : String(err)}) — no row appended; the index is unmeasurable, not empty`);
}

// The window ends "now" in UTC. Date.now() is intentional here (a CLI, not a resume-safe workflow
// script) and only sets the window's upper bound + the row's date stamp.
const now = Date.now();
const w = landMetricsWindow(read!, days, now, repo);

const floor = w.malformed > 0 ? ` (floor — ${w.malformed} malformed index line(s) skipped)` : "";
const flaggedClause = w.flagged > 0 ? `; ${w.flagged} with an unreadable/corrupt ledger at land time` : "";
const measuredClause = w.measured > 0
	? `${w.measured} citing measured reviewer precision across ${w.measuredDays} day(s)`
	: `0 citing measured reviewer precision`;
// Honest scope label: only a repo-filtered count is "self-lands"; an unfiltered count spans every repo
// sharing this state dir and must say so (grok #361 HIGH — never claim "glance's own PRs" unfiltered).
const scope = repo ? `rail self-lands (${repo})` : `rail lands (ALL repos in this state dir — not self-filtered; pass --repo to scope)`;
const row = `- ${utcDayOf(now)} — ${scope} (dogfood #339): last ${days}d ${w.lands} land(s) through the rail, ${measuredClause}; ${w.unmeasured} unmeasured${flaggedClause}${floor}.`;

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
