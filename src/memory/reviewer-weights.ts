/**
 * Reviewer-ensemble weights (CS329A borrow #3, plans/deepen-modules/16 — Weaver-lite): glance
 * runs a cross-lineage reviewer ensemble (grok, codex, native Claude passes) on every shipping
 * diff and adjudicates every finding against the code — but until now kept no record of which
 * lineage raised what and whether it survived. Weaver's result is that filtering weak verifiers
 * and weighting the rest recovers verification accuracy worth whole model classes; the
 * prerequisite is MEASURED per-verifier precision, which is exactly what this module computes.
 *
 * The ledger itself is a repo-committed JSONL (plans/.reviews/reviewer-ledger.jsonl, one row
 * per ADJUDICATED finding), written by the review closing step (deepen skill step 7 /
 * blind-review) via scripts/reviewer-ledger.ts — reviews happen in sessions and worktrees, not
 * in the daemon, so the record is versioned with the code it judged rather than hidden in a
 * stateDir. This module is the pure half: parse + aggregate + render; the daemon can surface
 * it via an API later without touching the write path.
 *
 * Honesty rules (the horizon-curve lesson, same day): a lineage's precision is reported with
 * its n; below `MIN_FINDINGS_FOR_WEIGHT` adjudicated findings the aggregation refuses to call
 * the number a weight at all — it is labeled provisional. Clean bills are NOT rows (a review
 * that found nothing asserts nothing adjudicable); refuted ARCHITECTURE-review claims are rows
 * (a claim is a finding wherever it was raised).
 *
 * glance#332 (the land-path moat centerpiece): `reviewerPrecisionFor`/`reviewerPrecisionFromLedger`
 * below are the CONSUMABLE reader `src/validator.ts`'s land-gate stamps onto every `ValidationRecord`
 * — one lineage's {n, survived, survivedRate} at judgment time, so the land receipt a human approves
 * cites a REAL measured number, never a fabricated or smoothed one. A lineage with zero adjudicated
 * rows OMITS `survivedRate` entirely (never present as `0`, and never present as an own key holding
 * `undefined` — `Object.hasOwn` must read `false`) — the caller's job is to print "unmeasured (n=0)",
 * not invent a rate. This is the one read-only extension to this module's "pure half" framing: it
 * touches `node:fs`, but only to READ the repo-committed ledger — `scripts/reviewer-ledger.ts`'s `add`
 * command remains the sole WRITER, untouched.
 *
 * Gauntlet round 1 (blind, dual-lineage — codex gpt-5.6-sol + grok-4.5, both converged on the cache
 * finding independently) hardened this reader further: a genuine READ FAULT (permission denied, a
 * FIFO/device path) is never conflated with an honestly ABSENT ledger (`unreadable` vs a plain `n:0`);
 * a ledger that's PARTIALLY corrupt (some malformed lines) still measures from its valid rows but
 * flags `rejected` on the stamp, and degrades FULLY to unmeasured only once malformed lines are a
 * large FRACTION of the file (a single stray bad line must not zero out real history).
 *
 * Round 1's own de-dup fix (keying on `at`+`lineage`+`concernClass`+`source`+`survived`, dropping
 * `note`/`severity`) was ITSELF a regression, caught in gauntlet round 2 (delta-verify, blind):
 * measured damage on the real committed ledger was 86 rows → 79, codex n 52 → 45 — four genuinely
 * DISTINCT PR #311 statistical-honesty findings collapsed into one because they happened to share
 * that 5-field tuple. The corrected rule (`semanticKey` below): two rows collapse ONLY when they are
 * identical across EVERY field after whitespace normalization (`note`/`severity` included) — this
 * still catches a byte-for-byte retried `add` (round 1's original target) and a whitespace-only
 * variant of the same row, but two rows that merely share date/lineage/class/source/outcome and
 * differ in their actual finding (`note`) are, correctly, two distinct adjudications and both count.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { errText } from "../err-text.ts";

export type ReviewerLineage = "grok" | "codex" | "native" | (string & {});

export interface ReviewerLedgerEntry {
	/** ISO date of the adjudication. */
	at: string;
	/** Which reviewer raised the finding. */
	lineage: ReviewerLineage;
	/** Kebab-case concern class, e.g. "statistical-honesty", "semantics-drift", "security-rbac". */
	concernClass: string;
	/** Did the finding survive adjudication against the code (real defect / real required change)? */
	survived: boolean;
	/** What was reviewed — a PR, commit range, or plan reference. */
	source: string;
	/** One-line description of the finding. */
	note: string;
	/** Reviewer-assigned severity, when one was given. */
	severity?: "high" | "medium" | "low";
}

/** Below this many adjudicated findings, a lineage's precision is provisional, not a weight. */
export const MIN_FINDINGS_FOR_WEIGHT = 10;

/**
 * Full-content identity for de-duplication, CORRECTED in gauntlet round 2 (delta-verify): round 1's
 * key dropped `note`/`severity`, which collapsed genuinely DISTINCT findings that merely happened to
 * share `at`+`lineage`+`concernClass`+`source`+`survived` — measured damage on the real ledger was
 * 86→79 rows, codex n 52→45. Every field (INCLUDING `note` and `severity`) must agree, after trimming
 * incidental whitespace, for two rows to count as the same adjudication — this still catches a
 * byte-for-byte retried `add` and a whitespace-only variant of the same row (round 1's actual target),
 * but never merges two rows whose underlying finding differs.
 *
 * `JSON.stringify` of the field TUPLE, not a raw separator-join (gauntlet round 3, delta-verify:
 * "dedup-nul-cross-collision" — a `"\0"`-joined key is only injective while no field's CONTENT can
 * itself contain the literal separator; a hand-edited row can carry an embedded `\0` via a JSON
 * string escape, which broke that assumption and made two DIFFERENT tuples hash identically).
 * `JSON.stringify` on an array escapes every field's internal quotes/backslashes/control characters
 * and uses the array's own comma/bracket structure as the delimiter, so no field content — NUL
 * included — can forge a collision with a genuinely different tuple, regardless of what's inside any
 * one field.
 */
function semanticKey(e: Pick<ReviewerLedgerEntry, "at" | "lineage" | "concernClass" | "source" | "survived" | "note" | "severity">): string {
	return JSON.stringify([e.at.trim(), e.lineage.trim(), e.concernClass.trim(), e.source.trim(), e.survived, e.note.trim(), e.severity ?? ""]);
}

/** Parse the JSONL ledger text. Malformed lines are counted in `rejected`, never guessed at;
 *  fully-identical-after-normalization duplicate rows (see `semanticKey` — EVERY field, `note`/
 *  `severity` included, whitespace-trimmed) are counted in `duplicates` and kept once — a retried
 *  `add` command must not inflate a lineage's precision or clear its provisional floor, but two rows
 *  that differ in their actual finding are always both counted, however similar their other fields
 *  (adversarial-review finding; corrected in gauntlet round 2 after round 1's coarser key regressed
 *  this — see the module doc above). */
export function parseReviewerLedger(text: string): { entries: ReviewerLedgerEntry[]; rejected: number; duplicates: number } {
	const entries: ReviewerLedgerEntry[] = [];
	const seen = new Set<string>();
	let rejected = 0;
	let duplicates = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			// No `as`-cast (json-parse-as-cast ratchet): parse to unknown, narrow field-by-field —
			// this file is hand-editable repo data, a genuine trust boundary.
			const parsed: unknown = JSON.parse(trimmed);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				rejected++;
				continue;
			}
			const raw: Record<string, unknown> = { ...parsed };
			if (
				typeof raw.at === "string" &&
				typeof raw.lineage === "string" &&
				typeof raw.concernClass === "string" &&
				typeof raw.survived === "boolean" &&
				typeof raw.source === "string" &&
				typeof raw.note === "string"
			) {
				// Trim BEFORE the enum check (gauntlet round 3, delta-verify: "severity-not-normalized" —
				// a strict `=== "high"` comparison discarded " high " as invalid instead of accepting it as
				// the same severity with incidental whitespace, so it silently dropped out of the dedup
				// key while every other field was trimmed consistently — two rows differing only in that
				// whitespace wrongly counted as distinct).
				const trimmedSeverity = typeof raw.severity === "string" ? raw.severity.trim() : raw.severity;
				const severity = trimmedSeverity === "high" || trimmedSeverity === "medium" || trimmedSeverity === "low" ? trimmedSeverity : undefined;
				const key = semanticKey({ at: raw.at, lineage: raw.lineage, concernClass: raw.concernClass, source: raw.source, survived: raw.survived, note: raw.note, severity });
				if (seen.has(key)) {
					duplicates++;
					continue;
				}
				seen.add(key);
				entries.push({
					at: raw.at,
					lineage: raw.lineage,
					concernClass: raw.concernClass,
					survived: raw.survived,
					source: raw.source,
					note: raw.note,
					...(severity ? { severity } : {}),
				});
			} else {
				rejected++;
			}
		} catch {
			rejected++;
		}
	}
	return { entries, rejected, duplicates };
}

/** Terminal-output hygiene: lineage/class/note strings come from a hand-edited file — strip
 *  control characters and newlines so a crafted row cannot forge report lines or erase the
 *  provisional warning (adversarial-review finding). */
function plain(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\u0000-\u001f\u007f\u009b]+/g, " ").trim();
}

export interface LineagePrecision {
	lineage: string;
	raised: number;
	survived: number;
	/** survived/raised. */
	precision: number;
	/** True until `raised` reaches MIN_FINDINGS_FOR_WEIGHT — a provisional number is not a weight. */
	provisional: boolean;
	/** Per concern class, for "where does this reviewer earn benefit of the doubt". */
	byClass: { concernClass: string; raised: number; survived: number; precision: number }[];
}

export function reviewerPrecision(entries: ReviewerLedgerEntry[]): LineagePrecision[] {
	const byLineage = new Map<string, ReviewerLedgerEntry[]>();
	for (const e of entries) {
		const list = byLineage.get(e.lineage) ?? [];
		list.push(e);
		byLineage.set(e.lineage, list);
	}
	const out: LineagePrecision[] = [];
	for (const [lineage, list] of byLineage) {
		const classes = new Map<string, { raised: number; survived: number }>();
		let survived = 0;
		for (const e of list) {
			const c = classes.get(e.concernClass) ?? { raised: 0, survived: 0 };
			c.raised++;
			if (e.survived) {
				c.survived++;
				survived++;
			}
			classes.set(e.concernClass, c);
		}
		out.push({
			lineage,
			raised: list.length,
			survived,
			precision: survived / list.length,
			provisional: list.length < MIN_FINDINGS_FOR_WEIGHT,
			byClass: [...classes.entries()]
				.map(([concernClass, c]) => ({ concernClass, raised: c.raised, survived: c.survived, precision: c.survived / c.raised }))
				.sort((a, b) => b.raised - a.raised),
		});
	}
	return out.sort((a, b) => b.raised - a.raised);
}

/** The repo-committed ledger's canonical path, resolved relative to THIS module (`src/memory/` — two
 *  dirs below repo root) — mirrors `scripts/reviewer-ledger.ts`'s own `LEDGER` constant so the two
 *  never drift onto different files. Callers may override for tests/fixtures. */
export const DEFAULT_REVIEWER_LEDGER_PATH = path.join(import.meta.dir, "..", "..", "plans", ".reviews", "reviewer-ledger.jsonl");

/** The git repo root that OWNS `DEFAULT_REVIEWER_LEDGER_PATH` — wherever THIS glance checkout is
 *  installed, not any particular tenant repo a land happens to be operating on (T5 gauntlet round 1,
 *  finding A1: the reviewer ledger is a daemon-global artifact, tracked in the daemon's OWN source
 *  tree, independent of which repo a given land is landing into). `src/rail/panel-ledger.ts`'s
 *  projection lane locks and commits against THIS root by default — never the landed tenant repo,
 *  which in a multi-tenant daemon may be a completely different checkout. */
export const DEFAULT_REVIEWER_LEDGER_REPO = path.join(import.meta.dir, "..", "..");

/**
 * Append one row to the reviewer ledger — the SAME write `scripts/reviewer-ledger.ts`'s `add` command
 * performs, extracted here (T5, glance#333) so an IN-PROCESS caller (the in-daemon review panel,
 * `src/rail/panel.ts`) can record an adjudicated finding without shelling out to a subprocess. The CLI
 * now delegates to this function too — there is exactly ONE write path, never two independently
 * drifting implementations of "append a JSONL row".
 *
 * Deliberately does NOT catch: a genuine write fault (disk full, permission denied, a bad `ledgerPath`)
 * must be visible to the caller, not silently swallowed here — this module's own honesty discipline
 * (never fabricate, never silently drop) applies to the WRITE side too. The land path's caller wraps
 * this in its own try/catch (mirrors the lens-panel's "advisory only, never break a land" discipline) so
 * a ledger-write fault can degrade a MEASUREMENT, never a MERGE.
 *
 * No cache invalidation needed: `readReviewerLedgerEntries`'s cache keys on the file's own (mtimeNs,
 * size), which this write changes by construction — the very next read sees the new row.
 */
export function appendReviewerLedgerEntry(entry: ReviewerLedgerEntry, ledgerPath: string = DEFAULT_REVIEWER_LEDGER_PATH): void {
	mkdirSync(path.dirname(ledgerPath), { recursive: true });
	appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}

export interface ReviewerPrecisionStamp {
	/** The ledger lineage tag this stamp was computed for (e.g. "codex", "grok", "native"). */
	lineage: string;
	/** Adjudicated findings raised by this lineage across the whole ledger (valid rows only — see
	 *  `rejected`/`corrupt` below for what "valid" excludes). */
	n: number;
	/** Of those, how many survived adjudication (a real defect / required change). Always 0 when n is 0. */
	survived: number;
	/** survived/n. Present as an OWN KEY only when `n > 0` — omitted entirely (never present holding
	 *  `undefined`) when `n === 0`, so `Object.hasOwn(stamp, "survivedRate")` is a reliable presence
	 *  check, not just a value check (gauntlet round 1, codex: "survivedRate present-as-undefined"). */
	survivedRate?: number;
	/** True below `MIN_FINDINGS_FOR_WEIGHT` adjudicated findings — a provisional number, not yet a weight.
	 *  Also true (trivially) whenever `n === 0`. */
	provisional: boolean;
	/** Malformed/unparseable lines encountered in the ledger READ that produced this stamp — a
	 *  whole-file count, not scoped to this lineage. Present only when `> 0` (gauntlet round 1, codex:
	 *  "partial-corrupt ledger" — a mid-append crash or a hand-edit typo must be visible on the stamp,
	 *  not silently absorbed into a confident-looking number). */
	rejected?: number;
	/** `true` when `rejected` was a large enough FRACTION of the ledger's lines that the surviving rows
	 *  can't be trusted at all for this read — `n`/`survived` are forced to `0` (no `survivedRate`) and
	 *  the caller must render this as fully unmeasured, distinct from an honest "no history yet" (the
	 *  reason — `rejected`'s count — is still carried so the render can explain WHY). Present only when
	 *  `true`; a lesser (nonzero but minor) `rejected` fraction leaves `n`/`survived`/`survivedRate`
	 *  computed from the valid rows, just flagged via `rejected`. */
	corrupt?: true;
	/** Present only when the ledger file itself could NOT be read — a permission fault, a non-regular
	 *  file (a FIFO/socket/device swapped in for the path), or any other I/O error. Distinct from a
	 *  simply ABSENT ledger (a fresh checkout, or a lineage never reviewed yet), which is normal and
	 *  NEVER sets this field — conflating "couldn't check" with "checked and found nothing" is the
	 *  T3-lesson failure mode this guards against (gauntlet round 1, grok: "read-error == no-history"). */
	unreadable?: string;
}

/**
 * Measured precision for ONE lineage, from an already-parsed entry list — glance#332's land-path
 * moat: `{n, survived, survivedRate}`, never smoothed. `survivedRate` is OMITTED entirely (not merely
 * `undefined`-valued) exactly when `n === 0` (no adjudicated history for this lineage) — the caller
 * must render that as "unmeasured", never as a `0`-valued precision, which would misread as "measured
 * and 0%". This is the PURE half — it never sees `rejected`/`corrupt`/`unreadable`, which are read-time
 * facts about the ledger FILE, not lineage-scoped facts about already-parsed rows; see
 * `reviewerPrecisionFromLedger` for where those attach.
 */
export function reviewerPrecisionFor(entries: ReviewerLedgerEntry[], lineage: string): ReviewerPrecisionStamp {
	const rows = entries.filter((e) => e.lineage === lineage);
	const n = rows.length;
	const survived = rows.filter((e) => e.survived).length;
	return {
		lineage,
		n,
		survived,
		...(n > 0 ? { survivedRate: survived / n } : {}),
		provisional: n < MIN_FINDINGS_FOR_WEIGHT,
	};
}

/** `rejected` lines AT OR PAST this FRACTION of the ledger's total lines (valid + duplicate +
 *  rejected) means the surviving rows can no longer be trusted to represent the true picture —
 *  degrade fully to unmeasured rather than confidently reporting a number computed from a shrinking,
 *  unrepresentative subset (gauntlet round 1, codex's "partial-corrupt ledger", adjudicated: NOT a
 *  blanket zero-on-any-corruption rule, which would make the whole feature flap on every ordinary
 *  mid-append race). `>=` is deliberate, not `>` (gauntlet round 2, delta-verify, finding 4): AT
 *  exactly the threshold the surviving half is no more trustworthy than the rejected half, so
 *  degrading is the SAFER read — the boundary sits ON the unmeasured side, not off it. */
const CORRUPT_REJECTED_FRACTION = 0.5;

interface ParsedLedgerCacheEntry {
	mtimeNs: bigint;
	size: bigint;
	parsed: { entries: ReviewerLedgerEntry[]; rejected: number; duplicates: number };
}

/**
 * Module-level cache of the last successfully parsed ledger PER PATH, invalidated on (mtimeNs, size)
 * — gauntlet round 2 (delta-verify), "hot-path-full-ledger-reread": every non-skipped land resolution
 * calls this reader, and a full `readFileSync` + re-parse of the WHOLE ledger on every call — even
 * when nothing changed since the last read — is an unbounded, event-loop-blocking cost as the ledger
 * grows; two cache hits in a row meant two full re-reads. `statSync` still runs on every call (cheap,
 * no full read), so the FRESHNESS invariant is unchanged: an append changes the file's mtime and size,
 * which busts this cache and forces a real re-read on the very next call. Combining mtimeNs (bigint,
 * nanosecond-resolution where the filesystem supports it) WITH size means even a same-nanosecond-tick
 * append (a real risk in a fast test loop) still invalidates correctly, since appending necessarily
 * changes the byte count too.
 */
const parsedLedgerCache = new Map<string, ParsedLedgerCacheEntry>();

// Test-only instrumentation: counts actual `readFileSync`+parse calls (cache MISSES only), so a test
// can assert the mtime/size cache is doing its job without reaching into fs internals. Never read by
// production code.
let readCountForTests = 0;
/** @substrate exported for tests only — no production caller needs the raw miss count. */
export function reviewerLedgerReadCountForTests(): number {
	return readCountForTests;
}
/** Resets the miss counter AND clears the parsed-ledger cache, so tests don't leak state into each
 *  other via the shared module-level cache. @substrate exported for tests only. */
export function resetReviewerLedgerCacheForTests(): void {
	readCountForTests = 0;
	parsedLedgerCache.clear();
}

/**
 * Read + parse the ledger file. Never throws — every failure mode degrades to an honest stamp instead
 * of blocking the land path that calls this:
 *  - the file is genuinely ABSENT (`ENOENT`) ⇒ plain `{entries:[], rejected:0, duplicates:0}`, no
 *    `unreadable` — a fresh checkout or a never-reviewed lineage is normal, not an error.
 *  - the path exists but is NOT a regular file (a FIFO/socket/device — e.g. something shadowing the
 *    real ledger) ⇒ `unreadable` set WITHOUT attempting a read, so a blocking pipe can never hang the
 *    synchronous land-path read (gauntlet round 1, codex's "env ledger-shadow" finding).
 *  - any OTHER read fault (permission denied, I/O error) ⇒ `unreadable` set, distinct from an absent
 *    file (gauntlet round 1, grok's "read-error == no-history" finding).
 *  - otherwise: a cheap `statSync` decides whether the parsed-ledger cache is still valid (gauntlet
 *    round 2's cache, above) before paying for a full read + re-parse.
 * `ledgerPath` defaults to the repo-committed ledger; tests pass a fixture path directly (dependency
 * injection — there is deliberately no environment-variable override reachable from production, so a
 * launch-directory `.env` can never redirect this read; see `src/validator.ts`'s `ValidatorGateOpts.reviewerLedgerPath`).
 */
export function readReviewerLedgerEntries(ledgerPath: string = DEFAULT_REVIEWER_LEDGER_PATH): { entries: ReviewerLedgerEntry[]; rejected: number; duplicates: number; unreadable?: string } {
	let stat: BigIntStats;
	try {
		stat = statSync(ledgerPath, { bigint: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			parsedLedgerCache.delete(ledgerPath); // a previously-cached path can genuinely disappear
			return { entries: [], rejected: 0, duplicates: 0 };
		}
		return { entries: [], rejected: 0, duplicates: 0, unreadable: errText(err) };
	}
	if (!stat.isFile()) {
		parsedLedgerCache.delete(ledgerPath); // a previously-valid path can become a non-regular file
		return { entries: [], rejected: 0, duplicates: 0, unreadable: `not a regular file: ${ledgerPath}` };
	}
	const cached = parsedLedgerCache.get(ledgerPath);
	if (cached && cached.mtimeNs === stat.mtimeNs && cached.size === stat.size) {
		return cached.parsed;
	}
	try {
		readCountForTests++;
		const parsed = parseReviewerLedger(readFileSync(ledgerPath, "utf8"));
		parsedLedgerCache.set(ledgerPath, { mtimeNs: stat.mtimeNs, size: stat.size, parsed });
		return parsed;
	} catch (err) {
		return { entries: [], rejected: 0, duplicates: 0, unreadable: errText(err) };
	}
}

/**
 * The one-call reader land code wants: this lineage's measured precision, straight from the
 * repo-committed ledger file. Never fabricates a rate, never applies a prior:
 *  - a read fault (see `readReviewerLedgerEntries`) ⇒ `unreadable` carried onto the stamp, `n:0`, no
 *    `survivedRate` — rendered distinctly from an honest "no history" by `renderReviewerPrecision`.
 *  - a ledger whose malformed-line fraction crosses `CORRUPT_REJECTED_FRACTION` ⇒ `corrupt:true`,
 *    `n:0`, no `survivedRate` — the surviving rows aren't trusted even though some parsed cleanly.
 *  - otherwise: real `n`/`survived`/`survivedRate` from the valid rows, with `rejected` carried along
 *    (present only when `> 0`) so a MINOR corruption is visible without forcing a full degrade.
 */
export function reviewerPrecisionFromLedger(lineage: string, ledgerPath: string = DEFAULT_REVIEWER_LEDGER_PATH): ReviewerPrecisionStamp {
	const { entries, rejected, duplicates, unreadable } = readReviewerLedgerEntries(ledgerPath);
	if (unreadable) return { lineage, n: 0, survived: 0, provisional: true, unreadable };
	const base = reviewerPrecisionFor(entries, lineage);
	if (rejected === 0) return base;
	const totalLines = entries.length + duplicates + rejected;
	const fraction = totalLines > 0 ? rejected / totalLines : 0;
	if (fraction >= CORRUPT_REJECTED_FRACTION) {
		return { lineage, n: 0, survived: 0, provisional: true, corrupt: true, rejected };
	}
	return { ...base, rejected };
}

/** `Math.round` alone collapses any true rate below 0.5% to a printed "0%" — indistinguishable from an
 *  honest, exact zero (gauntlet round 1, grok: n=201,survived=1 ⇒ 0.4975% ⇒ "0%" either way). A
 *  nonzero rate under 1% renders as "<1%" instead; an EXACT zero still renders "0%", so the two stay
 *  distinguishable. */
function formatPrecisionPct(rate: number): string {
	const pct = rate * 100;
	if (pct > 0 && pct < 1) return "<1%";
	return `${Math.round(pct)}%`;
}

/** Canonical one-line rendering of a precision stamp for a land receipt — "reviewer X, measured
 *  precision p% (n=N adjudicated rows)", or "reviewer X, unmeasured (n=0)" when the lineage has no
 *  adjudicated history yet. The honesty rule is sacred: never a fabricated or smoothed number for n=0,
 *  and (gauntlet round 1) an unreadable or too-corrupt-to-trust ledger renders as unmeasured too, with
 *  its own distinct reason — never silently folded into the plain "no history" case. */
export function renderReviewerPrecision(stamp: ReviewerPrecisionStamp): string {
	const who = plain(stamp.lineage);
	if (stamp.unreadable) return `${who}, unmeasured (ledger unreadable: ${plain(stamp.unreadable)})`;
	if (stamp.corrupt) {
		const rows = stamp.rejected ?? 0;
		return `${who}, unmeasured (ledger too corrupt to trust: ${rows} unparseable row${rows === 1 ? "" : "s"})`;
	}
	if (stamp.n === 0) return `${who}, unmeasured (n=0)`;
	// Defensive: `n > 0` should always carry a finite `survivedRate` (reviewerPrecisionFor's own
	// invariant) — but a wire-boundary value that violates it must still render honestly, never as a
	// fabricated percentage (gauntlet round 1, codex: "fabricated 0%" via `?? 0`).
	if (stamp.survivedRate === undefined || !Number.isFinite(stamp.survivedRate)) return `${who}, unmeasured (n=${stamp.n}, rate unavailable)`;
	const pct = formatPrecisionPct(stamp.survivedRate);
	const tag = stamp.provisional ? " [provisional]" : "";
	const corruptionNote = stamp.rejected ? `; ${stamp.rejected} row${stamp.rejected === 1 ? "" : "s"} unparseable` : "";
	return `${who}, measured precision ${pct} (n=${stamp.n} adjudicated row${stamp.n === 1 ? "" : "s"}${corruptionNote})${tag}`;
}

/** Render the report the closing step prints — sentence-first, n on every number. */
export function renderReviewerReport(entries: ReviewerLedgerEntry[], rejected: number, duplicates = 0): string {
	const lines: string[] = [];
	if (entries.length === 0) {
		// An all-malformed ledger must not read as an empty one (adversarial-review finding).
		lines.push("reviewer ledger is empty — no adjudicated findings recorded yet.");
	} else {
		for (const l of reviewerPrecision(entries)) {
			const tag = l.provisional ? " [provisional — not yet a weight]" : "";
			lines.push(`${plain(l.lineage)}: ${l.survived}/${l.raised} findings survived adjudication (${Math.round(l.precision * 100)}%)${tag}`);
			for (const c of l.byClass) {
				lines.push(`  ${plain(c.concernClass)}: ${c.survived}/${c.raised}`);
			}
		}
	}
	if (rejected > 0) lines.push(`(${rejected} malformed ledger line${rejected === 1 ? "" : "s"} ignored — fix them, they are data)`);
	if (duplicates > 0) lines.push(`(${duplicates} duplicate row${duplicates === 1 ? "" : "s"} (same adjudication, note/severity aside) counted once — a retried add must not inflate precision)`);
	return lines.join("\n");
}
