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
		baseline: 0,
	},
	{
		id: "json-parse-as-cast",
		description: "`JSON.parse(...) as T` with no validation — at a TRUST BOUNDARY (untrusted/persisted input) replace with a Schema decode. Triage before tightening: parsing our own freshly-written data is fine.",
		regex: /JSON\.parse\([^;{}]*\)\s+as\s+[A-Za-z]/,
		allowlist: ["src/schema/"], // schema modules re-narrow VALIDATED output; that `as` is sound
		// 55→52: the three flagged REAL trust boundaries now decode via src/schema/external-json.ts —
		// the workos.ts JWT payload (the follow-up debt called out here previously), federation.ts's
		// `tailscale whois` output (another binary's stdout), and plane.ts's PLANE_PROJECT_MAP env JSON.
		// The remaining 52 are mostly our-own-persisted-state parses; keep triaging before tightening.
		// 52→54 (eap-borrows follow-up, concern 01 producer): src/baseline-tracker.ts's two
		// `JSON.parse(...) as unknown` reads (baseline-tracker.json, baseline-pins.json) — the exact
		// "parsing our own freshly-written data" carve-out this pattern's own description names,
		// mirroring threshold-tuner.ts's identical already-baselined idiom byte-for-byte.
		// 54→55 (comprehension concern 01): src/attention.ts's `loadSeenMap` reads its own
		// `attention-seen.json` — same carve-out, same idiom, one more freshly-written state file.
		// 55->56 (comprehension concern 08): src/attention.ts's `loadSurpriseCounts` reads its own
		// `attention-surprise.json` -- same file, same carve-out, one more freshly-written state map.
		// 56->58 (land-assessment concerns 01/02): src/land-assessment/id.ts's `readAttemptCounter`
		// reads its own freshly-written `attempt-counter.json` state file, and
		// src/land-assessment/replay/incident-taxonomy.ts's `loadIncidentManifest` parses
		// `incident-manifest.json` immediately validated via `validateIncidentManifest` before any
		// caller sees it -- same carve-outs this pattern's own description names, two more sites.
		baseline: 58,
	},
	{
		id: "bool-env-compare",
		description: '`process.env.X === "1"` scattered boolean parsing — replace with envBool from src/config.ts (see the equivalence table on that helper)',
		regex: /process\.env\.[A-Z_]+\s*[!=]==\s*"[01]"/,
		// config.ts is the helper's own home — its envBool doc comment cites the legacy idioms verbatim
		// (same reason it's allowlisted for number-env-or-default). Everything else still counts.
		allowlist: ["src/config.ts"],
		// 52→19: envBool built + every site migrated except the files a parallel wave owns
		// (src/squad-manager.ts ×16, src/land-pr.ts ×2, src/harness-registry.ts ×1) — those
		// stay COUNTED as legacy so the next burn-down still sees them.
		baseline: 19,
	},
	{
		id: "error-message-idiom",
		description: "`err instanceof Error ? err.message : String(err)` — the shape that a tagged-error hierarchy replaces (not yet built; tracked, not urgent)",
		regex: /instanceof Error \? /,
		allowlist: [],
		// 88→91: reland stale-baseline correction (no tagged-error hierarchy exists yet to migrate TO).
		// 91→90: land()'s outcome-record block routes through squad-manager's `errText` helper
		// (3 inline sites → 1 helper line) pending the tagged-error hierarchy — the ratchet only goes DOWN.
		// 90→89: the set-model spawn-failure split (fix/spawnhost-unhandled-rejection) routes both of its
		// detail strings through `errText` instead of the inline idiom — one net occurrence removed.
		// 89→88: main had drifted RED to 94 — the per-unit verify base-diff feature's sites (executor.ts ×2,
		// verify-baseline.ts ×4) landed as inline idioms without a bump. All 6 now route through `errText`,
		// dropping the real count to 88 (the ratchet only goes DOWN; no tagged-error hierarchy exists yet).
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
