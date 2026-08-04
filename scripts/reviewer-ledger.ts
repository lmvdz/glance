/**
 * The reviewer-ledger closing step (CS329A borrow #3, plans/deepen-modules/16).
 *
 *   bun scripts/reviewer-ledger.ts add --lineage grok --class statistical-honesty \
 *     --survived true --source "PR #311 horizon diff" --note "cumulative laundering" [--severity high]
 *   bun scripts/reviewer-ledger.ts report
 *
 * One row per ADJUDICATED finding (see src/memory/reviewer-weights.ts for the rules: clean
 * bills are not rows; refuted claims are). The ledger is repo-committed JSONL so the record
 * versions with the code it judged.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReviewerLedger, renderReviewerReport, type ReviewerLedgerEntry } from "../src/memory/reviewer-weights.ts";

const LEDGER = path.join(import.meta.dir, "..", "plans", ".reviews", "reviewer-ledger.jsonl");

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const value = i >= 0 ? process.argv[i + 1] : undefined;
	// A missing value must not swallow the next flag (`--lineage --class x` would otherwise
	// record lineage:"--class" — adversarial-review finding).
	return value !== undefined && !value.startsWith("--") ? value : undefined;
}

const cmd = process.argv[2];
if (cmd === "add") {
	const lineage = arg("lineage");
	const concernClass = arg("class");
	const survivedRaw = arg("survived");
	const source = arg("source");
	const note = arg("note");
	const severity = arg("severity");
	if (!lineage || !concernClass || !source || !note || (survivedRaw !== "true" && survivedRaw !== "false")) {
		console.error('usage: add --lineage <grok|codex|native|…> --class <kebab-tag> --survived <true|false> --source "<PR/range>" --note "<one line>" [--severity high|medium|low]');
		process.exit(2);
	}
	const entry: ReviewerLedgerEntry = {
		at: new Date().toISOString().slice(0, 10),
		lineage,
		concernClass,
		survived: survivedRaw === "true",
		source,
		note,
		...(severity === "high" || severity === "medium" || severity === "low" ? { severity } : {}),
	};
	mkdirSync(path.dirname(LEDGER), { recursive: true });
	appendFileSync(LEDGER, `${JSON.stringify(entry)}\n`);
	console.log(`recorded: [${entry.lineage}] ${entry.concernClass} survived=${entry.survived} — ${entry.note}`);
} else if (cmd === "report") {
	const text = existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "";
	const { entries, rejected, duplicates } = parseReviewerLedger(text);
	console.log(renderReviewerReport(entries, rejected, duplicates));
} else {
	console.error("usage: bun scripts/reviewer-ledger.ts <add|report> …");
	process.exit(2);
}
