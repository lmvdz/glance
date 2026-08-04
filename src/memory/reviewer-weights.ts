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
 */

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

/** Parse the JSONL ledger text. Malformed lines are counted in `rejected`, never guessed at;
 *  byte-identical duplicate rows are counted in `duplicates` and kept once — a retried `add`
 *  command must not inflate a lineage's precision or clear its provisional floor
 *  (adversarial-review finding). */
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
				// Byte-identical lines only — exactly what a retried `add` appends. Rows that differ
				// in ANY field (even severity) are distinct adjudications and both count.
				if (seen.has(trimmed)) {
					duplicates++;
					continue;
				}
				seen.add(trimmed);
				entries.push({
					at: raw.at,
					lineage: raw.lineage,
					concernClass: raw.concernClass,
					survived: raw.survived,
					source: raw.source,
					note: raw.note,
					...(raw.severity === "high" || raw.severity === "medium" || raw.severity === "low" ? { severity: raw.severity } : {}),
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
	if (duplicates > 0) lines.push(`(${duplicates} exact-duplicate row${duplicates === 1 ? "" : "s"} counted once — a retried add must not inflate precision)`);
	return lines.join("\n");
}
