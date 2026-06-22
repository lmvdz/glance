/**
 * Tier-0 deterministic code-fix pass for the verify cascade. BEFORE spending any AI tokens on the
 * fixup tier, apply TypeScript's OWN code-fixes — auto-import, wrong-import-path, spelling — through
 * the language service. Zero model tokens.
 *
 *   verify ─(fail)→ codefix (this) → fixup (cheap AI) → escalate (grounded AI) → human
 *
 * Best-effort by contract: it NEVER throws and always exits 0. It's a pre-pass, not a gate — if the
 * project won't load or nothing is fixable, it's a no-op and the cascade proceeds to fixup.
 */

import * as path from "node:path";
import ts from "typescript";

/** Diagnostic codes whose code-fixes are import-path / spelling corrections (never logic changes). */
const FIXABLE: Record<number, true> = {
	2304: true, // cannot find name
	2305: true, // module has no exported member
	2307: true, // cannot find module
	2551: true, // property does not exist on type (did you mean …)
	2552: true, // cannot find name (did you mean …)
};

/** Code-fix actions we trust to be mechanical: add/repair an import, or correct a typo. */
const SAFE_FIXES: Record<string, true> = { import: true, fixImport: true, fixMissingImport: true, spelling: true };

// ponytail: cascading fixes (an added import that surfaces the next missing name) settle in ≤3 passes.
const MAX_PASSES = 3;

export function applyCodefixes(projectDir: string): { fixed: number; files: number } {
	try {
		const configPath = ts.findConfigFile(projectDir, ts.sys.fileExists, "tsconfig.json");
		if (!configPath) return summarize(0, 0);
		const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
		if (error) return summarize(0, 0);
		const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
		const targets = parsed.fileNames.filter((f) => !f.includes("node_modules") && !f.endsWith(".d.ts"));
		if (targets.length === 0) return summarize(0, 0);

		// Language service over the project; snapshots read straight from disk, version bumps per write
		// so each pass sees the previous pass's edits.
		const versions = new Map<string, number>();
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => parsed.fileNames,
			getScriptVersion: (f) => String(versions.get(f) ?? 0),
			getScriptSnapshot: (f) => {
				const text = ts.sys.readFile(f);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getCurrentDirectory: () => projectDir,
			getCompilationSettings: () => parsed.options,
			getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
		};
		const service = ts.createLanguageService(host, ts.createDocumentRegistry());

		let fixed = 0;
		const touched = new Set<string>();
		for (let pass = 0; pass < MAX_PASSES; pass++) {
			// Gather every safe text change across the project for this pass, grouped by target file.
			const byFile = new Map<string, ts.TextChange[]>();
			let passFixes = 0;
			for (const file of targets) {
				for (const diag of service.getSemanticDiagnostics(file)) {
					if (diag.start === undefined || diag.length === undefined || !FIXABLE[diag.code]) continue;
					const fixes = service.getCodeFixesAtPosition(file, diag.start, diag.start + diag.length, [diag.code], {}, {});
					const fix = fixes.find((f) => SAFE_FIXES[f.fixName]); // candidates are alternatives — take the first safe one
					if (!fix) continue;
					passFixes++;
					for (const change of fix.changes) {
						if (change.isNewFile) continue; // a local-module import never creates a file
						const list = byFile.get(change.fileName) ?? [];
						list.push(...change.textChanges);
						byFile.set(change.fileName, list);
					}
				}
			}
			if (passFixes === 0) break; // converged

			for (const [file, changes] of byFile) {
				const original = ts.sys.readFile(file);
				if (original === undefined) continue;
				const next = applyChanges(original, changes);
				if (next === original) continue;
				ts.sys.writeFile(file, next);
				versions.set(file, (versions.get(file) ?? 0) + 1);
				touched.add(file);
			}
			fixed += passFixes;
		}

		return summarize(fixed, touched.size);
	} catch {
		return summarize(0, 0); // best-effort: a pre-pass never fails the cascade
	}
}

/** Splice changes into `text`, highest offset first so earlier spans stay valid; dedupe identical edits, skip overlaps. */
function applyChanges(text: string, changes: ts.TextChange[]): string {
	const seen = new Set<string>();
	const sorted = changes
		.filter((c) => {
			const key = `${c.span.start}:${c.span.length}:${c.newText}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => b.span.start - a.span.start);
	let out = text;
	let floor = Number.POSITIVE_INFINITY; // lowest start applied so far; anything reaching past it overlaps → skip
	for (const c of sorted) {
		if (c.span.start + c.span.length > floor) continue;
		out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
		floor = c.span.start;
	}
	return out;
}

function summarize(fixed: number, files: number): { fixed: number; files: number } {
	console.log(fixed > 0 ? `codefix: applied ${fixed} fix(es) across ${files} file(s)` : "codefix: no fixable issues");
	return { fixed, files };
}

if (import.meta.main) {
	applyCodefixes(process.argv[2] ?? ".");
}
