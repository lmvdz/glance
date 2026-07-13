/**
 * Defect-class ratchet + inventory — a sibling to `scripts/effect-migration.ts`.
 *
 * `effect-migration.ts` ratchets MIGRATION debt (legacy idioms with a clean Effect replacement).
 * This file ratchets REGRESSION debt: bug CLASSES that a completed review cycle spent real
 * subagent budget re-discovering by hand, each of which this repo has already paid down once and
 * has a proven, named replacement for. Kept separate from `effect-migration.ts` on purpose — these
 * three patterns aren't "not yet migrated to Effect", they're "don't reintroduce a fail-open/
 * fail-forever/evidence-destroying bug we already fixed" — a different ratchet PURPOSE deserves its
 * own file rather than diluting the Effect-migration inventory's single meaning. Same mechanism,
 * same discipline: `PATTERNS[]` below carries a committed `baseline` ceiling per pattern;
 * `tests/defect-ratchet.test.ts` asserts the live count never EXCEEDS it, so a PR that introduces a
 * NEW occurrence fails the suite, and fixing occurrences is a separate PR that lowers the baseline.
 *
 * Unlike `effect-migration.ts`'s patterns, a line-comment DOCUMENTING one of these defect classes
 * (e.g. "the OLD `.catch(() => ({ ok: true }))` used to...") is not itself the defect — and this
 * repo's own fail-closed sweep left exactly that kind of history comment behind at
 * `src/observer.ts:585`. A naive line-regex would count it, which would make writing an honest
 * post-mortem comment about a FIXED bug fail the ratchet for reintroducing it. So `scan()` here
 * skips comment-only lines (a trimmed line starting with `//`, `/*`, or `*`) before testing a
 * pattern — a small, deliberate refinement over `effect-migration.ts`'s pure line-regex (see that
 * file's `catch-returns-allow`-equivalent gap: none of its four patterns currently have a
 * comment/prose collision, so it never needed this). The same refinement is why
 * `flagEfficiencyRegression`/`isCostReproducible`/`detectBaselineStaleness` — genuinely dead exports
 * only ever MENTIONED in a doc comment elsewhere, never called — correctly read as unreferenced by
 * `scripts/dead-exports.ts`'s identifier-token scan rather than "referenced" by the prose about them.
 */
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pattern } from "./effect-migration.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export interface DefectPattern extends Pattern {
	/** When set, ONLY these files (repo-relative, exact or prefix match) are scanned — the inverse
	 *  of `allowlist`. Used when the legitimate replacement already exists in a small, known set of
	 *  files (raw-truncate-on-judged-path): enumerating "every other src/ file" as an `allowlist`
	 *  would be brittle against new files landing elsewhere. Absent ⇒ scans all of src/**\/*.ts, same
	 *  as a base `Pattern`. */
	scope?: string[];
}

export const PATTERNS: DefectPattern[] = [
	{
		id: "catch-returns-allow",
		description:
			"An error path that reads as success — `.catch(() => ({ ok: true }))`, `.catch(() => true)`, " +
			"`catch { return true }`, `catch (e) { return { ok: true } }` and their kin. An inconclusive " +
			"check is a FAILED check: return a block/inconclusive verdict, never an allow, from a catch. " +
			"This is the class behind the historical fail-open regression gate (a Docker outage or a " +
			"transient spawn failure silently read as main-green) and 13 of 16 findings in the review " +
			"cycle that motivated this ratchet.",
		regex:
			/\.catch\(\(\)\s*=>\s*\(\{\s*ok:\s*true|\.catch\(\(\)\s*=>\s*true\)|catch\s*\{\s*return\s+true\b|catch\s*\([^)]*\)\s*\{\s*return\s*\{\s*ok:\s*true/,
		allowlist: [],
		// Measured 0 (2026-07-10): the only textual hit was a history comment at src/observer.ts:585
		// documenting the now-fixed `.catch(() => ({ ok: true }))` (eap-borrows finding #12) — excluded
		// by scan()'s comment skip, so it never counted. Locked at 0, not aspirationally but because
		// that's the true measured count; any REAL occurrence is a new regression, full stop.
		baseline: 0,
	},
	{
		id: "hand-written-retryable",
		description:
			"A NEW hand-written `retryable: true` must be a reviewed event — not because the literal is " +
			"wrong (the 14 below are deliberate and load-bearing) but because getting its polarity " +
			"backwards has twice wedged this factory. Read BOTH failure modes before you add one:\n" +
			"  - retryable-forever: 1,381 of 1,708 historical land attempts died retryable and never " +
			"escalated. FIXED at the manager, not the call site — `landBlockedEscalateCap` (default 20) " +
			"now bounds every retryable refusal and fires a 'Needs you' escalation per episode.\n" +
			"  - permanent park: hardcoding `retryable: false` on a PROBE FAILURE (offline daemon, pruned " +
			"`origin/<default>`, corrupt .git) turns a transient hiccup into a branch that never retries " +
			"and never un-parks — 'the interlock pathology re-introduced one probe over' (land-pr.ts).\n" +
			"So do NOT mechanically route a land-loop refusal through `classifyProbeFailure`'s verdict: " +
			"absent a `maxAttempts` budget it returns `retryable: false, escalate: true`, which PARKS the " +
			"branch. Those call sites correctly take only its `.reason` and set `retryable: true` " +
			"themselves, because the land loop's budget is the ~30s retry tick + the escalate cap. Use " +
			"the classification's own `retryable` ONLY where the caller has no retry loop (observer, " +
			"convergence, land-risk). An environmental precondition is retryable; a branch defect is not.",
		regex: /retryable:\s*true\b/,
		// The taxonomy module's own home — `classifyProbeFailure` computes `retryable` from a budget
		// comparison, never writes the literal `true` today, but a future structural-failure branch
		// legitimately could; this is the one place that literal is the taxonomy itself, not a bypass.
		allowlist: ["src/classify-probe-failure.ts"],
		// Measured 14 (2026-07-10): all in src/land.ts and src/land-pr.ts's refusal paths, and every one
		// is a DELIBERATE anti-park flag — see land.ts:450-455 ("treat 'couldn't confirm clean' the SAME
		// as 'confirmed dirty': retryable — an environmental precondition, not a branch defect") and
		// land-pr.ts:543-548 (`retryable: false` there "turned a transient hiccup into a PERMANENT park").
		// This is a CEILING, not a debt to burn down: do not "migrate" these to 0. An adversarial design
		// review (2026-07-10) caught this ratchet's first description telling authors to do exactly that.
		// 3 further textual hits are history comments (land-mode.ts:142, land.ts:686, squad-manager.ts:345)
		// and don't count — see the module doc's comment-skip rationale.
		// 15th reviewed 2026-07-13: squad-manager.ts's `inconclusive` land-diff refusal (PR #166) — the
		// diff itself couldn't be COMPUTED (environmental git fault), so there is no verdict to park on;
		// the retry lane + the same escalate-cap episode accounting bound it. Correct polarity. #160 and
		// #166 merged as siblings, so this baseline was locked before the 15th literal existed.
		baseline: 15,
	},
	{
		id: "raw-truncate-on-judged-path",
		description:
			"`truncate(` on a judge-facing artifact now that budgetedExcerpt/writeGateLog exist " +
			"(src/gate-logs.ts) — blind truncation destroys the artifact under judgement (a validator veto " +
			"or pass becomes unrecoverable once the tail is gone). Use budgetedExcerpt: whole-hunk packing " +
			"for diffs, head+tail for logs, never throws, and persists the FULL text behind a pointer " +
			"instead of discarding it.",
		regex: /\btruncate\(/,
		allowlist: [],
		// Scoped to the three files gate-logs.ts's module doc names as the validator/land judged paths —
		// everywhere else in src/ a `truncate(` (if any) isn't feeding a judge prompt, so it's out of
		// this pattern's scope entirely rather than allowlisted file-by-file.
		scope: ["src/validator.ts", "src/land.ts", "src/land-pr.ts"],
		// Measured 10 (2026-07-10): validator.ts 4 (incl. its own `truncate()` helper definition — the
		// helper's continued existence is as much the debt as its call sites), land.ts 6 (ditto, its own
		// helper + 5 call sites). land-pr.ts: 0 — already clean. One land.ts textual hit (line 220) is a
		// history comment quoting the old idiom and doesn't count.
		baseline: 10,
	},
];

export interface Finding {
	pattern: DefectPattern;
	count: number;
	files: { file: string; line: number; text: string }[];
}

function isAllowlisted(relPath: string, allowlist: string[]): boolean {
	return allowlist.some((p) => relPath === p || relPath.startsWith(p));
}

function inScope(relPath: string, scope: string[] | undefined): boolean {
	if (!scope) return true;
	return scope.some((p) => relPath === p || relPath.startsWith(p));
}

/** A trimmed line that is itself a comment (line comment, or block-comment open/continuation) — see
 *  the module doc for why this is excluded before pattern matching. Deliberately simple (no
 *  multi-line block-comment STATE tracking): a `/**` block spans several lines, but the interior
 *  lines here all start with `*` in this codebase's house style (see effect-migration.ts,
 *  gate-logs.ts, this file), so per-line prefix matching catches them without needing to track
 *  comment-open/close state across lines. */
function isCommentOnly(line: string): boolean {
	const t = line.trim();
	return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

/** Scan src/ (or a pattern's narrower `scope`) and count occurrences of each pattern (allowlisted
 *  paths and comment-only lines excluded). */
export function scan(): Finding[] {
	const files = [...new Glob("src/**/*.ts").scanSync(REPO_ROOT)].sort();
	return PATTERNS.map((pattern) => {
		const hits: Finding["files"] = [];
		for (const rel of files) {
			if (!inScope(rel, pattern.scope)) continue;
			if (isAllowlisted(rel, pattern.allowlist)) continue;
			const lines = readFileSync(join(REPO_ROOT, rel), "utf8").split("\n");
			lines.forEach((text, i) => {
				if (isCommentOnly(text)) return;
				if (pattern.regex.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim() });
			});
		}
		return { pattern, count: hits.length, files: hits };
	});
}

/** Print a human report when run directly: `bun scripts/defect-ratchet.ts [--files]` */
if (import.meta.main) {
	const showFiles = process.argv.includes("--files");
	const findings = scan();
	let regressions = 0;
	console.log("\nDefect-class ratchet inventory (src/)\n" + "=".repeat(48));
	for (const { pattern, count, files } of findings) {
		const delta = count - pattern.baseline;
		const flag = delta > 0 ? ` ⚠️ +${delta} OVER baseline` : delta < 0 ? ` ✓ ${-delta} below — tighten baseline to ${count}` : " ✓ at baseline";
		if (delta > 0) regressions++;
		console.log(`\n${pattern.id}: ${count} / ${pattern.baseline} baseline${flag}`);
		console.log(`  ${pattern.description}`);
		if (showFiles) for (const f of files.slice(0, 40)) console.log(`    ${f.file}:${f.line}  ${f.text.slice(0, 90)}`);
	}
	console.log("\n" + "=".repeat(48));
	console.log(regressions === 0 ? "All patterns at or below baseline." : `${regressions} pattern(s) OVER baseline — ratchet broken.`);
	process.exit(regressions === 0 ? 0 : 1);
}
