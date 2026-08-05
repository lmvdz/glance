import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The rail's seam: src/rail/index.ts is the lane's interface; the modules inside the directory are
 * implementation. Cloned from tests/memory-lane-boundary.test.ts (glance#335, T7 slice 1 of the
 * rail-extraction design on lmvdz/glance#328). This test freezes the set of files OUTSIDE src/rail/
 * that deep-import rail internals at the set that existed right after the land-ledger + land-risk
 * move — land-risk.ts has NO barrel export by design (its sole consumer, src/land.ts, deep-imports it
 * directly), so that one coupling is seeded here deliberately, not as future debt. A NEW (file ->
 * module) coupling fails here: import from "./rail/index.ts" instead, or consciously extend the
 * allowlist in the same PR that justifies the new internal coupling.
 *
 * Deliberately a set-diff against an explicit allowlist, not a count ratchet: a count lets one
 * removed coupling mask one added elsewhere (the ratchet-drift failure mode).
 *
 * Scope, exactly matching the memory-lane template this was cloned from: the scanner walks
 * `src/**` only (`.ts`/`.tsx`). It does NOT scan `tests/**` or `scripts/**` — a test file that
 * deep-imports a rail module is not a boundary violation this test polices; only src-to-src
 * couplings define the lane's public seam.
 *
 * Gauntlet round 1 (PR #343, dual-lineage blind review — grok-4.5 + codex, adjudicated
 * independently): the original regex was FAIL-OPEN on four bypass forms it never matched, so a
 * coupling using any of them would silently never register as a hit, defeating both the "new
 * deep import" gate and the ratchet-down twin. Fixed here:
 *   (a) extensionless specifier — Bun resolves `from "./rail/land-ledger"` same as `...ts"`, but
 *       the old regex hardcoded `\.ts` as required, not optional.
 *   (b) bare side-effect imports — `import "./rail/x.ts";` (no `from` clause at all).
 *   (c) template-literal dynamic imports — `` import(`./rail/x.ts`) `` (old regex only matched
 *       quote/apostrophe delimiters, not backticks).
 *   (d) a block comment between the `from`/`import(` keyword and the specifier string.
 * `deepImportsInText` below is exercised directly against inline fixtures (one per bypass form,
 * plus a negative barrel-import fixture) so this scanner's own detection is proven, not assumed —
 * a scanner without a test proving it fires is exactly how the original hole shipped.
 */

const ALLOWED = new Set([
	"src/land.ts -> land-risk",
]);

const ROOT = join(import.meta.dir, "..");

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === "node_modules" || e === ".git" || e === "dist") continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
	}
	return out;
}

// One of ' " ` — a plain string/template-literal delimiter (no interpolation support needed: a
// dynamic `rail/` specifier is never templated with `${...}` in this codebase, and if it ever
// were, that itself would be worth a human's eyes, not silent detection).
const Q = `["'\`]`;
// Zero or more block comments (each optionally trailing whitespace) between a keyword and the
// specifier — covers `from/*x*/"..."` and `import(/*x*/"...")`. Line comments can't appear inline
// between a keyword and a string on the same statement in valid TS, so only `/* */` is handled.
const COMMENT = `(?:/\\*[\\s\\S]*?\\*/\\s*)*`;
// `./rail/<module>` or `../../rail/<module>`, `.ts` extension OPTIONAL (Bun resolves either).
const PATH = `[./]+rail/([a-z0-9-]+)(?:\\.ts)?`;

const DEEP_IMPORT_RE = new RegExp(
	[
		`from\\s*${COMMENT}${Q}${PATH}${Q}`, // import { x } from "./rail/y[.ts]"
		`import\\s*${COMMENT}${Q}${PATH}${Q}`, // bare side-effect: import "./rail/y[.ts]"
		`import\\s*\\(\\s*${COMMENT}${Q}${PATH}${Q}\\s*${COMMENT}\\)`, // dynamic: import(`./rail/y[.ts]`)
	].join("|"),
	"g",
);

/**
 * The scanner's actual matching logic, over a plain string — split out from file-walking so the
 * fixture tests below can drive it directly instead of only ever seeing it fire (or not) through
 * real repo files.
 */
function deepImportsInText(text: string): string[] {
	const hits: string[] = [];
	for (const m of text.matchAll(DEEP_IMPORT_RE)) {
		const mod = m[1] ?? m[2] ?? m[3];
		if (mod === "index") continue; // the barrel is the legal target
		if (mod) hits.push(mod);
	}
	return hits;
}

function deepImports(): string[] {
	const hits: string[] = [];
	for (const f of walk(join(ROOT, "src"))) {
		const rel = relative(ROOT, f).replace(/\\/g, "/");
		if (rel.startsWith("src/rail/")) continue; // the lane's own internals may deep-import freely
		// The import specifier, not the pathname, is what's matched — so NUL bytes elsewhere in a
		// file (server.ts has them) can't hide an import from a line-based scan.
		const text = readFileSync(f, "utf8");
		for (const mod of deepImportsInText(text)) hits.push(`${rel} -> ${mod}`);
	}
	return [...new Set(hits)].sort();
}

test("rail: no new deep imports past the src/rail seam", () => {
	const current = deepImports();
	const added = current.filter((h) => !ALLOWED.has(h));
	expect(
		added,
		`new deep import(s) into src/rail internals:\n  ${added.join("\n  ")}\n` +
			`Import from "src/rail/index.ts" (the lane's interface) instead — or, if the internal ` +
			`coupling is genuinely deliberate, extend the allowlist in this test in the same PR.`,
	).toEqual([]);
});

test("rail: allowlist entries that no longer exist get removed (ratchet down)", () => {
	const current = new Set(deepImports());
	const stale = [...ALLOWED].filter((a) => !current.has(a));
	expect(
		stale,
		`allowlisted deep imports no longer exist — delete them from ALLOWED so they can't come back:\n  ${stale.join("\n  ")}`,
	).toEqual([]);
});

// ── scanner self-test: flip-the-input fixtures (gauntlet round 1, PR #343) ─────────────────────
//
// Proves the scanner actually fires on each bypass form it was blind to, rather than trusting the
// regex by inspection. One fixture per form, plus a negative (barrel import) that must NOT fire.

test("rail boundary scanner: detects an extensionless specifier", () => {
	expect(deepImportsInText(`import { landFailureCount } from "./rail/land-ledger";`)).toEqual(["land-ledger"]);
});

test("rail boundary scanner: detects a bare side-effect import", () => {
	expect(deepImportsInText(`import "./rail/land-ledger.ts";`)).toEqual(["land-ledger"]);
});

test("rail boundary scanner: detects a template-literal dynamic import", () => {
	expect(deepImportsInText("const m = await import(`./rail/land-ledger.ts`);")).toEqual(["land-ledger"]);
});

test("rail boundary scanner: detects a specifier behind a block comment", () => {
	expect(deepImportsInText(`import { landFailureCount } from/*rail*/"./rail/land-ledger.ts";`)).toEqual(["land-ledger"]);
	expect(deepImportsInText("const m = await import(/*rail*/`./rail/land-risk.ts`/*end*/);")).toEqual(["land-risk"]);
});

test("rail boundary scanner: does NOT flag a barrel import", () => {
	expect(deepImportsInText(`import { readLandLedger } from "./rail/index.ts";`)).toEqual([]);
	expect(deepImportsInText(`import { readLandLedger } from "./rail/index";`)).toEqual([]);
});
