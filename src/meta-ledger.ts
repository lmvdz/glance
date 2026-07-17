/**
 * Shared meta-plan Ledger append machinery (plans/daily-dogfood-engine/03) — the ONE code path
 * through which scripts append rows to `plans/daily-driver/00-meta.md`'s `## Ledger` section.
 * Both writers ride it: scripts/append-adoption-ledger.ts (B02's weekly counter snapshot) and
 * scripts/append-drain-summary.ts (B03's weekly triage status line).
 *
 * Fail-closed by construction:
 *  - a file without a `## Ledger` heading throws — the row is inserted exactly at the end of the
 *    section that was verified to exist, never "somewhere";
 *  - the row must be a single `- `-prefixed line — no smuggling extra headings or paragraphs;
 *  - the row is refused if it contains verdict language (SUCCESS / KILL / etc.). The adoption
 *    gate's verdict is written ONLY by Lars, by hand, at the two-week gate review
 *    (plans/daily-dogfood-engine/03 is MODE: hitl for exactly this reason). No code path that
 *    goes through this module can ever write one — that is a structural guarantee the concern's
 *    Verify section demands, not a convention.
 */

/**
 * Verdict language the machinery refuses to append. `SUCCESS`/`KILL` are the literal gate
 * criteria tokens from 00-meta.md; `verdict`/`adopted`/`no-go` are the obvious equivalents an
 * agent drafting "counters look flat, recommend KILL" would reach for. `STOP` is matched
 * case-sensitively — the kill criterion shouts it ("… hasn't emerged, STOP"), while a lowercase
 * "stop the daemon" in a cluster note is ordinary prose and passes.
 */
const VERDICT_CI = /\b(success|kill|killed|verdict|adopted|no-go)\b/i;
const VERDICT_CS = /\bSTOP\b/;

/** Throws when `row` contains verdict language. Exported for direct testing; insertLedgerRow
 *  calls it unconditionally, so writers cannot opt out. */
/** @substrate exported for tests only — tests/meta-ledger.test.ts pins the hitl verdict-language guard directly. */
export function assertNoVerdictLanguage(row: string): void {
	const hit = VERDICT_CI.exec(row) ?? VERDICT_CS.exec(row);
	if (hit) {
		throw new Error(
			`row contains verdict language ("${hit[0]}") — the adoption-gate verdict is written only by Lars at gate review (plans/daily-dogfood-engine/03, MODE: hitl); reword the line without it`,
		);
	}
}

/**
 * Insert `row` at the END of `text`'s `## Ledger` section (before the next `## ` heading, or at
 * EOF when Ledger is the last section). Everything outside that one insertion point is
 * byte-identical. Throws (never writes partial output) on: no `## Ledger` heading, a multi-line
 * or non-`- `-prefixed row, or verdict language in the row.
 */
/** @substrate exported for tests only — tests/meta-ledger.test.ts pins idempotent row insertion directly. */
export function insertLedgerRow(text: string, row: string): string {
	if (row.includes("\n")) throw new Error("ledger row must be a single line");
	if (!row.startsWith("- ")) throw new Error('ledger row must start with "- " (a Markdown list entry)');
	assertNoVerdictLanguage(row);

	const headingMatch = /^## Ledger[ \t]*$/m.exec(text);
	if (!headingMatch) throw new Error('no "## Ledger" section — refusing to append anywhere else');
	const sectionStart = headingMatch.index + headingMatch[0].length;
	const nextHeading = text.slice(sectionStart).search(/^## /m);
	const sectionEnd = nextHeading === -1 ? text.length : sectionStart + nextHeading;
	// Trim trailing blank lines inside the section so the row lands right under the last entry.
	const body = text.slice(sectionStart, sectionEnd).replace(/\s+$/, "");
	const tail = text.slice(sectionEnd);
	return `${text.slice(0, sectionStart)}${body}\n${row}\n${nextHeading === -1 ? "" : "\n"}${tail}`;
}
