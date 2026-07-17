import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";

// ── env-catalog completeness gate (plans/webapp-voice-lane/02-env-example-test.md concern 02) ──
//
// .env.example claims (see its own header) to be kept complete by THIS test: every env var read
// in src/ must appear in .env.example, and every var documented in .env.example must be read
// somewhere in src/ (module scripts/-only pilot vars and a small explicit KNOWN_GAPS allowlist
// below excepted). Before this file existed the claim was false — .env.example had never been
// checked against src/ at all (~80 read vars were undocumented, and it had never been run).
//
// Scanning approach — this is a set of regex heuristics over the literal TypeScript source, not a
// real parser, chosen to match how this codebase ACTUALLY reads env vars:
//   1. `process.env.NAME` / `process.env["NAME"]` — the direct form.
//   2. `envBool("NAME", …)` / `envInt("NAME", …)` / `envNumber("NAME", …)` / `envStringList("NAME", …)`
//      — the typed readers in src/config.ts. `envBoolAliased("PRIMARY", "LEGACY", …)` counts as a
//      read of BOTH string arguments (batch-3 review: the primary/legacy-alias reader added for the
//      dead-alias fix).
//   3. `<param>.NAME` where `<param>` is a function parameter whose default value is literally
//      `process.env` (this codebase's dependency-injection convention for testable env reads —
//      e.g. `function f(env: NodeJS.ProcessEnv = process.env)` or
//      `function f(source: Record<string, string | undefined> = process.env)`). The parameter
//      name varies (env/source/base/…) so it's discovered per-file, not hardcoded — EXCEPT the
//      two files below whose reads are one further indirection away (a name stored in a runtime
//      registry, not read as a literal property access) and are special-cased explicitly.
// Full-line comments (`//…`, `* …`, `/**…`) are stripped before scanning so a comment that
// mentions an example var name (e.g. "Number(process.env.OMP_SQUAD_X)") isn't mistaken for a read.

const ROOT = path.resolve(import.meta.dir, "..");
const SRC_DIR = path.join(ROOT, "src");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

function isCommentLine(line: string): boolean {
	const t = line.trim();
	return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function codeLines(src: string): string[] {
	return src.split("\n").filter((l) => !isCommentLine(l));
}

function listTsFiles(dir: string): string[] {
	return (readdirSync(dir, { recursive: true }) as string[])
		.filter((f) => f.endsWith(".ts"))
		.map((f) => path.join(dir, f));
}

/** Every env var name this file's (non-comment) source literally reads. */
function readsInFile(file: string): Set<string> {
	const raw = readFileSync(file, "utf8");
	const body = codeLines(raw).join("\n");
	const names = new Set<string>();

	for (const m of body.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) names.add(m[1]);
	for (const m of body.matchAll(/process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g)) names.add(m[1]);
	for (const m of body.matchAll(/env(?:Bool|Int|Number|StringList)\(\s*["']([A-Z_][A-Z0-9_]*)["']/g)) names.add(m[1]);
	// envBoolAliased(primary, legacy, fallback) reads BOTH string literal args — the whole point of
	// the helper is that either name can decide the flag (batch-3 review, comprehension concern 09).
	for (const m of body.matchAll(/envBoolAliased\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*,\s*["']([A-Z_][A-Z0-9_]*)["']/g)) {
		names.add(m[1]);
		names.add(m[2]);
	}

	// DI-env-param convention: a parameter or local binding that resolves to `process.env`, either
	// directly as a parameter default (`env: NodeJS.ProcessEnv = process.env`, or the
	// `Record<string, string | undefined>` spelling some files use) or through a local fallback
	// (`const source = opts.source ?? process.env`). The bound name is discovered per-file (not
	// assumed to be "env") because this codebase uses env/source/base depending on the function.
	// Two separate patterns rather than one greedy one: a combined regex that lets the type
	// annotation span arbitrary characters up to the next "=" mis-binds on a multi-parameter
	// signature (e.g. `snapshot: X = {...}, env: NodeJS.ProcessEnv = process.env` mis-captured
	// "snapshot") because a plain-object default's own "=" isn't distinguishable from the real one
	// by a generic scan — so the parameter-default form is matched only against the two exact type
	// spellings this codebase actually uses, and the local-fallback form requires an explicit
	// const/let/var and a simple property-chain right-hand side (never an arbitrary expression).
	const paramNames = new Set<string>();
	for (const m of body.matchAll(/(\w+)\s*:\s*(?:NodeJS\.ProcessEnv|Record<string,\s*string\s*\|\s*undefined>)\s*=\s*process\.env\b/g)) {
		paramNames.add(m[1]);
	}
	for (const m of body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[\w.]+(?:\?\.[\w.]+)?\s*\?\?\s*process\.env\b(?!\.\w|\[)/g)) {
		paramNames.add(m[1]);
	}
	// Bare rebind (`const x = process.env;`, no fallback) — not currently used anywhere in src/ but
	// cheap to cover so a future one doesn't silently fall through the scan.
	for (const m of body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*process\.env\s*[;,)]/g)) {
		paramNames.add(m[1]);
	}
	for (const p of paramNames) {
		const re = new RegExp(`\\b${p}\\.([A-Z_][A-Z0-9_]*)\\b`, "g");
		for (const m of body.matchAll(re)) names.add(m[1]);
	}

	return names;
}

/**
 * Two files resolve an env var name through a static registry (a key literal in an array/object)
 * rather than a direct property read, so the generic scanner above can't see them. Both are small,
 * stable, explicitly named here rather than guessed at generically:
 *   - runtime-settings.ts's `FEATURE_FLAGS` entries are read via `env[flag.key]` (a *variable*
 *     key) — the literal names live in each entry's `key: "..."`.
 *   - metrics.ts's `FLAG_ENV` maps a flag id to its env var name, read via `process.env[envVar]`
 *     (again a variable key) inside `resolveVariant`.
 */
function specialCaseReads(): Set<string> {
	const names = new Set<string>();
	const runtimeSettings = readFileSync(path.join(SRC_DIR, "runtime-settings.ts"), "utf8");
	for (const m of runtimeSettings.matchAll(/key:\s*"([A-Z_][A-Z0-9_]*)"/g)) names.add(m[1]);
	const metrics = readFileSync(path.join(SRC_DIR, "metrics.ts"), "utf8");
	// FLAG_ENV is `Record<keyof LearningFlags, string>` — grab every quoted value assigned inside it.
	const flagEnvBlock = metrics.match(/FLAG_ENV[^{]*\{([^}]*)\}/);
	if (flagEnvBlock) {
		for (const m of flagEnvBlock[1].matchAll(/:\s*"([A-Z_][A-Z0-9_]*)"/g)) names.add(m[1]);
	}
	return names;
}

function allSrcReads(): Set<string> {
	const names = new Set<string>();
	for (const file of listTsFiles(SRC_DIR)) {
		for (const n of readsInFile(file)) names.add(n);
	}
	for (const n of specialCaseReads()) names.add(n);
	return names;
}

/** Var names documented in .env.example: a `# NAME=` line (commented-out, per the file's own convention). */
function documentedVars(): Set<string> {
	const raw = readFileSync(ENV_EXAMPLE, "utf8");
	const names = new Set<string>();
	for (const line of raw.split("\n")) {
		const m = /^# ([A-Z][A-Z0-9_]*)=/.exec(line);
		if (m) names.add(m[1]);
	}
	return names;
}

/**
 * src/env-compat.ts mirrors `OMP_SQUAD_<suffix>` <-> `GLANCE_<suffix>` bidirectionally at boot, so
 * either spelling is live at runtime regardless of which one a given line of code reads or a given
 * .env.example line documents. Expand a var set with both spellings of every aliasable name before
 * diffing, so e.g. `GLANCE_STATE_DIR` documented + `OMP_SQUAD_STATE_DIR` read (or vice versa) is
 * NOT flagged as drift.
 */
const LEGACY_PREFIX = "OMP_SQUAD_";
const CANON_PREFIX = "GLANCE_";
function expandAliases(names: Set<string>): Set<string> {
	const out = new Set(names);
	for (const n of names) {
		if (n.startsWith(LEGACY_PREFIX)) out.add(CANON_PREFIX + n.slice(LEGACY_PREFIX.length));
		else if (n.startsWith(CANON_PREFIX)) out.add(LEGACY_PREFIX + n.slice(CANON_PREFIX.length));
	}
	return out;
}

/** OS/toolchain env inherited by every process — not glance config, never documented in .env.example. */
const SYSTEM_ENV_EXEMPT = new Set([
	"HOME", // state-dir default fallback + repo-roots default
	"PATH", // spawn PATH augmentation
	"GIT_CONFIG_COUNT", // git's own env, read by git-harden.ts to append hermetic config entries
	"WSL_DISTRO_NAME", // OS-injected by WSL interop, read by src/here-web.ts isWsl — not glance config
]);

/** Pilot vars consumed only by scripts/ (forward-declared config, not yet wired into src/), per
 *  .env.example's own header. */
const SCRIPTS_ONLY = new Set(["ARCHIL_DISK", "ARCHIL_REGION", "ARCHIL_MOUNT_TOKEN"]);

/**
 * Documented vars with NO current src/ reader — each entry here is a real, verified gap (not a
 * hedge): the var is genuinely unread today. Kept as an explicit, justified allowlist rather than
 * silently dropped from .env.example or silently exempted, so the gap stays visible and the test's
 * bidirectional shape stays intact for every other var.
 */
const KNOWN_GAPS: Record<string, string> = {
	OMP_SQUAD_HEAT_HALFLIFE_MS: "documented context-heat decay half-life, but no context-heat decay consumer exists in src/ yet",
};

test("every env var read in src/ appears in .env.example (module DI-param / registry indirections included)", () => {
	const read = expandAliases(allSrcReads());
	const documented = expandAliases(documentedVars());
	const missing = [...read].filter((n) => !documented.has(n) && !SYSTEM_ENV_EXEMPT.has(n)).sort();
	expect(missing).toEqual([]);
});

test("every .env.example entry is read somewhere in src/ (ARCHIL pilot vars and KNOWN_GAPS excepted)", () => {
	const read = expandAliases(allSrcReads());
	const documented = expandAliases(documentedVars());
	const scriptsOnly = expandAliases(SCRIPTS_ONLY);
	const knownGaps = expandAliases(new Set(Object.keys(KNOWN_GAPS)));
	const unread = [...documented].filter((n) => !read.has(n) && !scriptsOnly.has(n) && !knownGaps.has(n)).sort();
	expect(unread).toEqual([]);
});

test("KNOWN_GAPS entries are still documented in .env.example (the allowlist doesn't rot into pointing at nothing)", () => {
	const documented = documentedVars();
	const stale = Object.keys(KNOWN_GAPS).filter((n) => !documented.has(n));
	expect(stale).toEqual([]);
});

test("ARCHIL scripts-only pilot vars are still documented (the exemption doesn't rot into pointing at nothing)", () => {
	const documented = documentedVars();
	const stale = [...SCRIPTS_ONLY].filter((n) => !documented.has(n));
	expect(stale).toEqual([]);
});
