/**
 * Dogfood-window instrumentation (landing-rail #339) — the READ + COUNT side of the land-receipt
 * index. `writeLandReceipt` (receipt/write.ts) appends one `LandReceiptIndexRow` per land to
 * `<stateDir>/land-receipts/index.jsonl`; this module reads that index and answers the one question
 * the 2-week destination gate asks: "how many of glance's own PRs did the rail land, WITH measured
 * reviewer precision, per day."
 *
 * Two counts, never conflated:
 *   - `lands`    — the change actually merged (`landed === true`), whatever the gate said.
 *   - `measured` — a subset: `landed` AND a validator stamped a lineage with `precision.n > 0`.
 *
 * `measured` is the destination's real evidence. A land nobody has yet measured a reviewer's
 * precision for (`precision` absent, or present with `n === 0`) is NOT evidence and is never counted
 * as such — the same honesty invariant every gauntlet round enforced (absence must read as unknown,
 * never as a confident zero). Malformed index lines are surfaced as a count, never silently absorbed.
 *
 * The by-day/window functions are PURE (rows in, structured counts out — unit-testable with no
 * scratch daemon); `readLandReceiptIndex` is the one I/O wrapper. A missing index is an honest empty
 * (ENOENT ⇒ no lands yet); any OTHER read error THROWS rather than fabricate an empty window.
 */

import * as fs from "node:fs/promises";
import type { LandReceiptIndexRow } from "./receipt/types.ts";
import { landReceiptIndexPath } from "./receipt/write.ts";

/** UTC calendar day (`YYYY-MM-DD`) of an epoch-ms timestamp — DST-free, machine-agnostic bucketing,
 *  the same convention `adoption-counters.ts#utcDayOf` uses (kept local to avoid a cross-concern
 *  import; both are the trivial `toISOString().slice(0,10)`). */
export function utcDayOf(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

export interface LandReceiptIndexRead {
	rows: LandReceiptIndexRow[];
	/** Unparseable / shape-invalid lines encountered — surfaced so a mid-append crash or hand-edit is
	 *  visible on the count, not absorbed into a confident-looking number. */
	malformed: number;
}

/** A row is only counted if it carries the fields the counter keys on. A JSON object missing `at`
 *  (the bucketing key) or `landed` (the merge truth) is malformed — parsing it as a zero-day,
 *  not-landed row would silently corrupt the count. */
function parseIndexRow(line: string): LandReceiptIndexRow | null {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof obj !== "object" || obj === null) return null;
	const o = obj as Record<string, unknown>;
	if (typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
	if (typeof o.landed !== "boolean") return null;
	if (typeof o.repo !== "string" || typeof o.branch !== "string") return null;
	// precision, when present, must be a well-formed measured stamp — a malformed precision object is
	// dropped to "unmeasured" (no precision) rather than trusted, so a corrupt stamp can never inflate
	// the `measured` count.
	let precision: LandReceiptIndexRow["precision"];
	if (o.precision != null) {
		const p = o.precision as Record<string, unknown>;
		if (typeof p.lineage === "string" && typeof p.n === "number" && Number.isFinite(p.n) && typeof p.survived === "number" && Number.isFinite(p.survived)) {
			precision = {
				lineage: p.lineage,
				n: p.n,
				survived: p.survived,
				// Preserve the "couldn't trust the ledger" flags (grok #361) — they both hard-exclude the
				// row from `measured`, so dropping them would be unsafe, not just lossy.
				...(p.corrupt === true ? { corrupt: true as const } : {}),
				...(typeof p.unreadable === "string" ? { unreadable: p.unreadable } : {}),
			};
		}
	}
	return {
		at: o.at,
		repo: o.repo,
		branch: o.branch,
		...(typeof o.commit === "string" ? { commit: o.commit } : {}),
		landed: o.landed,
		forced: o.forced === true,
		gateStatus: (typeof o.gateStatus === "string" ? o.gateStatus : "failed") as LandReceiptIndexRow["gateStatus"],
		...(precision ? { precision } : {}),
	};
}

/** Read + parse the land-receipt index for a state dir. Missing file ⇒ honest empty. Any other read
 *  error (permission, I/O) THROWS — an unreadable index is NOT "zero lands", and treating it as such
 *  would silently under-report the gate's evidence. */
export async function readLandReceiptIndex(stateDir: string): Promise<LandReceiptIndexRead> {
	let text: string;
	try {
		text = await fs.readFile(landReceiptIndexPath(stateDir), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { rows: [], malformed: 0 };
		throw err;
	}
	const rows: LandReceiptIndexRow[] = [];
	let malformed = 0;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const row = parseIndexRow(t);
		if (row) rows.push(row);
		else malformed++;
	}
	return { rows, malformed };
}

/** True when a row is a real merge with a *trustworthy* measured reviewer-precision stamp — the
 *  destination's evidence. Requires: `landed`, NOT `forced` (a human override that bypassed the proof
 *  gate is not the rail deciding safely — grok #361 / the row type's own contract), a `precision`
 *  with `n > 0`, and neither the `corrupt` nor `unreadable` ledger-quality flag set (both are forced
 *  to `n === 0` upstream, but a hand-built/wire row could carry `n > 0` alongside them — exclude
 *  explicitly, defence in depth). */
export function isMeasuredLand(row: LandReceiptIndexRow): boolean {
	const p = row.precision;
	return row.landed === true && row.forced !== true && p != null && p.n > 0 && p.corrupt !== true && p.unreadable == null;
}

const bump = (acc: Record<string, number>, day: string): void => {
	acc[day] = (acc[day] ?? 0) + 1;
};

/** `{ "YYYY-MM-DD": count }` of rows that actually merged, per UTC day. Sparse. */
export function landsByDay(rows: LandReceiptIndexRow[]): Record<string, number> {
	const acc: Record<string, number> = {};
	for (const r of rows) if (r.landed) bump(acc, utcDayOf(r.at));
	return acc;
}

/** `{ "YYYY-MM-DD": count }` of MEASURED lands (landed ∧ precision.n>0), per UTC day. Sparse. */
export function measuredLandsByDay(rows: LandReceiptIndexRow[]): Record<string, number> {
	const acc: Record<string, number> = {};
	for (const r of rows) if (isMeasuredLand(r)) bump(acc, utcDayOf(r.at));
	return acc;
}

export interface LandMetricsWindow {
	/** The repo the window was filtered to, or `undefined` for "all repos sharing this state dir".
	 *  When `undefined` the counts are NOT self-scoped — the caller must not label them "self-lands". */
	repo?: string;
	/** Inclusive UTC-day bounds of the window, `YYYY-MM-DD`. */
	sinceDay: string;
	untilDay: string;
	/** Days in the window (e.g. 7). */
	days: number;
	/** Rows that merged within the window (after the optional repo filter). */
	lands: number;
	/** Of those, rows carrying a TRUSTWORTHY measured stamp (see `isMeasuredLand`) — the gate's
	 *  evidence. */
	measured: number;
	/** Merged-but-unmeasured within the window (`lands - measured`) — surfaced so the gap is legible,
	 *  never hidden. */
	unmeasured: number;
	/** Distinct UTC days within the window that had at least one MEASURED land — the "how continuous"
	 *  signal the 2-week gate cares about (14 lands on one day is not 2 weeks of dogfooding). */
	measuredDays: number;
	/** Landed rows in the window whose precision carried a `corrupt`/`unreadable` ledger-quality flag —
	 *  the validator ran but couldn't trust its own ledger. Surfaced so a run of these reads as a
	 *  measurement problem, not as honest silence. */
	flagged: number;
	/** Malformed index lines seen (carried through from the read) — a nonzero value means the count
	 *  is a floor, not exact. */
	malformed: number;
}

/**
 * Summarize the last `days` UTC days ending at `now` (epoch ms). Pure over (rows, now, repo). The
 * window is [untilDay - (days-1) .. untilDay] inclusive by UTC calendar day, so `days: 7` with `now`
 * = today covers today and the six prior days. Rows outside the window are ignored; rows exactly on
 * the boundary days are included.
 *
 * `repo`, when given, filters to lands of THAT repo only — the self-vs-fleet split (grok #361 HIGH):
 * many repos can share one state dir, so a count that means "glance's OWN PRs" MUST filter on repo,
 * not sum everything the daemon landed. When `repo` is omitted the result's `repo` is `undefined` and
 * the counts span all repos — honest, but the caller must label them "rail lands", never "self-lands".
 */
export function landMetricsWindow(read: LandReceiptIndexRead, days: number, now: number, repo?: string): LandMetricsWindow {
	const untilDay = utcDayOf(now);
	// sinceDay = now shifted back (days-1) whole days, in UTC.
	const sinceMs = now - (days - 1) * 86_400_000;
	const sinceDay = utcDayOf(sinceMs);
	let lands = 0;
	let measured = 0;
	let flagged = 0;
	const measuredDaySet = new Set<string>();
	for (const r of read.rows) {
		if (repo != null && r.repo !== repo) continue; // self-vs-fleet filter
		const day = utcDayOf(r.at);
		if (day < sinceDay || day > untilDay) continue;
		if (!r.landed) continue;
		lands++;
		if (r.precision?.corrupt === true || r.precision?.unreadable != null) flagged++;
		if (isMeasuredLand(r)) {
			measured++;
			measuredDaySet.add(day);
		}
	}
	return {
		repo,
		sinceDay,
		untilDay,
		days,
		lands,
		measured,
		unmeasured: lands - measured,
		measuredDays: measuredDaySet.size,
		flagged,
		malformed: read.malformed,
	};
}
