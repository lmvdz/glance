/**
 * Effect-migration ratchet + inventory.
 *
 * "Update all legacy code" is not a big-bang rewrite — it's a ratchet. Each entry
 * below is a legacy pattern we're migrating away from, with a committed `baseline`
 * count. `tests/effect-ratchet.test.ts` asserts the live count never EXCEEDS the
 * baseline, so:
 *   - a PR that introduces a NEW occurrence fails the suite (no backsliding), and
 *   - when you migrate some occurrences, you tighten (lower) the baseline in the
 *     same PR — the number only ratchets down, never up.
 *
 * This deliberately does NOT demand a 100% rewrite: some legacy is correct as-is
 * (a `throw` for an internal invariant, a `JSON.parse` of our own state file). We
 * gate the patterns that have a clean Effect replacement and let the count shrink
 * as boundaries migrate. Run `bun scripts/effect-migration.ts` for the live report.
 *
 * Baselines re-anchored to current `main` at re-land time (this ratchet was orphaned
 * off main after its original PR #88 merge, so the wire drifted while nothing enforced
 * it): number-env-or-default TIGHTENED 38→4 (migrations landed meanwhile), and the three
 * un-migrated patterns re-locked at their present ceilings (json 52→54, bool 44→50,
 * error-idiom 82→88). The gate now enforces no-further-backslide from today.
 */
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Pattern {
	id: string;
	/** What it is and what to migrate it to. */
	description: string;
	/** Matched per line across src/**\/*.ts. */
	regex: RegExp;
	/** Files/dirs (repo-relative prefixes) where this pattern is legitimate, not legacy. */
	allowlist: string[];
	/** Locked ceiling. The live count must be <= this. Lower it when you migrate. */
	baseline: number;
}

const REPO_ROOT = join(import.meta.dir, "..");

export const PATTERNS: Pattern[] = [
	{
		id: "number-env-or-default",
		description: "`Number(process.env.X) || d` silently eats a legit 0 and coerces garbage — replace with envInt/envNumber from src/config.ts",
		regex: /Number\(process\.env\.[A-Z_]+\)\s*\|\|/,
		allowlist: ["src/config.ts"],
		baseline: 4,
	},
	{
		id: "json-parse-as-cast",
		description: "`JSON.parse(...) as T` with no validation — at a TRUST BOUNDARY (untrusted/persisted input) replace with a Schema decode. Triage before tightening: parsing our own freshly-written data is fine.",
		regex: /JSON\.parse\([^;{}]*\)\s+as\s+[A-Za-z]/,
		allowlist: ["src/schema/"], // schema modules re-narrow VALIDATED output; that `as` is sound
		baseline: 54,
	},
	{
		id: "bool-env-compare",
		description: '`process.env.X === "1"` scattered boolean parsing — candidate for a typed envBool helper (not yet built)',
		regex: /process\.env\.[A-Z_]+\s*[!=]==\s*"[01]"/,
		allowlist: [],
		baseline: 50,
	},
	{
		id: "error-message-idiom",
		description: "`err instanceof Error ? err.message : String(err)` — the shape that a tagged-error hierarchy replaces (not yet built; tracked, not urgent)",
		regex: /instanceof Error \? /,
		allowlist: [],
		baseline: 88,
	},
];

export interface Finding {
	pattern: Pattern;
	count: number;
	files: { file: string; line: number; text: string }[];
}

function isAllowlisted(relPath: string, allowlist: string[]): boolean {
	return allowlist.some((p) => relPath === p || relPath.startsWith(p));
}

/** Scan src/ and count occurrences of each pattern (allowlisted paths excluded). */
export function scan(): Finding[] {
	const files = [...new Glob("src/**/*.ts").scanSync(REPO_ROOT)].sort();
	return PATTERNS.map((pattern) => {
		const hits: Finding["files"] = [];
		for (const rel of files) {
			if (isAllowlisted(rel, pattern.allowlist)) continue;
			const lines = readFileSync(join(REPO_ROOT, rel), "utf8").split("\n");
			lines.forEach((text, i) => {
				if (pattern.regex.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim() });
			});
		}
		return { pattern, count: hits.length, files: hits };
	});
}

/** Print a human report when run directly: `bun scripts/effect-migration.ts [--files]` */
if (import.meta.main) {
	const showFiles = process.argv.includes("--files");
	const findings = scan();
	let regressions = 0;
	console.log("\nEffect migration inventory (src/)\n" + "=".repeat(48));
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
