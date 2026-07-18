/**
 * Synthetic concurrent-change pair generator (concern 05) — the fourth BRIEF §10.4 evaluation source:
 * class-tagged (B, M, C)-shaped triples over REAL dogfood-repo TS files, produced by controlled,
 * AST-LOCATED, deterministically-seeded text mutations — never an LLM, never actual git commits (these
 * are in-memory content triples; wiring them through the live analyzer, if ever done, is concern 06's
 * call, not this module's).
 *
 * "AST-located": `ts.createSourceFile` finds WHERE to splice (an exported function's parameter list, a
 * class's heritage clause, an import statement's insertion point) deterministically; the mutation
 * itself is a targeted string splice at that located span, not a full AST-to-Printer regeneration —
 * simpler and immune to Printer reformatting surprises, while still being informed by the real syntax
 * tree rather than a blind regex over raw text.
 *
 * Four mutation kinds, matching `typescript-structural-delta.ts`'s own claimed predicates 1:1 so a
 * synthetic pair is guaranteed to trigger the fact the class names:
 *   signature-change            add an optional parameter to an exported function/const ⇒
 *                                SIGNATURE_CHANGED (arity-changed, per `classifySignatureChange`'s own
 *                                priority order — arity is checked first).
 *   export-removal              delete an entire exported declaration ⇒ EXPORTS_REMOVED.
 *   inheritance-change          add/rename a class or interface's `extends` target ⇒ EXTENDS_CHANGED.
 *   adjacent-dependency-edit    prepend a new relative import ⇒ IMPORTS_ADDED.
 *
 * Determinism: candidate selection among multiple eligible targets in one file is `seed % count` over
 * candidates sorted by their own source position (stable, independent of any Map/Set iteration order).
 * No `Date.now()`, no `Math.random()`, no I/O — the SAME `(sourcePath, sourceContent, kind, seed)`
 * ALWAYS produces byte-identical output (the concern's own Verify requirement: "synthetic pairs
 * regenerate byte-identically from the same seed").
 *
 * Circularity caveat (DESIGN.md's Risks, restated here so it travels with the artifact): these pairs
 * are generated with the SAME `ts.createSourceFile` API the analyzer detects with. A report built from
 * synthetic-only recall on this class must label it as such — concern 06's job, not this module's; this
 * module only tags every pair with `taxonomyClass` so that report can never lose the label.
 */

import { createHash } from "node:crypto";
import * as ts from "typescript";
import type { TaxonomyClass } from "./incident-taxonomy.ts";

export type SyntheticMutationKind = "signature-change" | "export-removal" | "inheritance-change" | "adjacent-dependency-edit";

export const SYNTHETIC_MUTATION_KINDS: readonly SyntheticMutationKind[] = ["signature-change", "export-removal", "inheritance-change", "adjacent-dependency-edit"];

/** Which taxonomy class each mutation kind is tagged with — matches `CLAIMED_BY["typescript-structural-delta"]`
 *  (`incident-taxonomy.ts`) exactly: the first three are `structural-api`, the fourth is `dependency`. */
export const SYNTHETIC_MUTATION_CLASS: Readonly<Record<SyntheticMutationKind, TaxonomyClass>> = {
	"signature-change": "structural-api",
	"export-removal": "structural-api",
	"inheritance-change": "structural-api",
	"adjacent-dependency-edit": "dependency",
};

export interface SynthesizeInput {
	/** Display-only path fed to the parser — drives `.tsx` vs `.ts` script-kind selection. Never read
	 *  from disk by this module; `sourceContent` is the caller-supplied real file content. */
	sourcePath: string;
	sourceContent: string;
	kind: SyntheticMutationKind;
	seed: number;
}

export interface SyntheticPair {
	id: string;
	kind: SyntheticMutationKind;
	taxonomyClass: TaxonomyClass;
	seed: number;
	sourcePath: string;
	/** B — the unmutated original content. */
	baseContent: string;
	/** M — the "main" side. Identical to `baseContent` by construction (this generator produces ONE
	 *  targeted mutation on the candidate side only; a concurrent main-side edit is a distinct,
	 *  composable concern this module does not attempt). */
	mainContent: string;
	/** C — `baseContent` with the targeted mutation applied. */
	candidateContent: string;
	/** Human-readable description of exactly what was mutated (which symbol/import) — the audit trail
	 *  for "why did this pair get tagged this class". */
	mutationDetail: string;
}

export type SynthesizeResult = { ok: true; pair: SyntheticPair } | { ok: false; reason: string };

function stableId(...parts: string[]): string {
	return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function parseDiagnosticsOf(sf: ts.SourceFile): readonly ts.Diagnostic[] {
	return (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

function diagnosticMessage(d: ts.Diagnostic): string {
	return typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
}

function parseSource(sourcePath: string, sourceContent: string): { ok: true; sf: ts.SourceFile } | { ok: false; reason: string } {
	if (sourceContent.includes("\0")) return { ok: false, reason: "binary-content: source contains a NUL byte" };
	const scriptKind = sourcePath.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sf = ts.createSourceFile(sourcePath, sourceContent, ts.ScriptTarget.Latest, true, scriptKind);
	const diagnostics = parseDiagnosticsOf(sf);
	if (diagnostics.length > 0) return { ok: false, reason: `parse-error: ${diagnosticMessage(diagnostics[0]!)}` };
	return { ok: true, sf };
}

function hasExportModifier(stmt: ts.Statement): boolean {
	const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
	return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Deterministic pick among `candidates` (already sorted by source position) — `seed % length`, so the
 *  same seed always selects the same target regardless of how many candidates exist; negative seeds
 *  wrap into range rather than throwing. */
function pick<T>(candidates: readonly T[], seed: number): T | undefined {
	if (candidates.length === 0) return undefined;
	const idx = ((seed % candidates.length) + candidates.length) % candidates.length;
	return candidates[idx];
}

function splice(content: string, start: number, end: number, replacement: string): string {
	return content.slice(0, start) + replacement + content.slice(end);
}

function finish(input: SynthesizeInput, candidateContent: string, mutationDetail: string): SynthesizeResult {
	return {
		ok: true,
		pair: {
			id: stableId("synthetic", input.kind, input.sourcePath, String(input.seed)),
			kind: input.kind,
			taxonomyClass: SYNTHETIC_MUTATION_CLASS[input.kind],
			seed: input.seed,
			sourcePath: input.sourcePath,
			baseContent: input.sourceContent,
			mainContent: input.sourceContent,
			candidateContent,
			mutationDetail,
		},
	};
}

// ── signature-change ────────────────────────────────────────────────────────────────────────────────

interface SignatureChangeCandidate {
	name: string;
	insertAt: number;
	/** `", "` when appending after an existing last parameter, `""` when the parameter list was empty
	 *  (`insertAt` then points at the position right before the closing paren). */
	prefix: string;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
	return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function findSignatureChangeCandidates(sf: ts.SourceFile): SignatureChangeCandidate[] {
	const out: SignatureChangeCandidate[] = [];
	const addCandidate = (name: string, params: ts.NodeArray<ts.ParameterDeclaration>): void => {
		if (params.length > 0) out.push({ name, insertAt: params[params.length - 1]!.getEnd(), prefix: ", " });
		else out.push({ name, insertAt: params.pos, prefix: "" });
	};
	for (const stmt of sf.statements) {
		if (!hasExportModifier(stmt)) continue;
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			addCandidate(stmt.name.text, stmt.parameters);
			continue;
		}
		if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
				if (isFunctionLike(decl.initializer)) addCandidate(decl.name.text, decl.initializer.parameters);
			}
		}
	}
	return out.sort((a, b) => a.insertAt - b.insertAt);
}

function synthesizeSignatureChange(sf: ts.SourceFile, input: SynthesizeInput): SynthesizeResult {
	const candidates = findSignatureChangeCandidates(sf);
	const target = pick(candidates, input.seed);
	if (!target) return { ok: false, reason: "no exported function/const found — signature-change is inapplicable to this file" };
	const candidateContent = splice(input.sourceContent, target.insertAt, target.insertAt, `${target.prefix}__synthParam?: string`);
	return finish(input, candidateContent, `added optional parameter __synthParam to exported function/const "${target.name}" — arity-changed`);
}

// ── export-removal ──────────────────────────────────────────────────────────────────────────────────

interface RemovableCandidate {
	name: string;
	start: number;
	end: number;
}

function findExportRemovalCandidates(sf: ts.SourceFile): RemovableCandidate[] {
	const out: RemovableCandidate[] = [];
	for (const stmt of sf.statements) {
		if (!hasExportModifier(stmt)) continue;
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			out.push({ name: stmt.name.text, start: stmt.getFullStart(), end: stmt.getEnd() });
		} else if (ts.isClassDeclaration(stmt) && stmt.name) {
			out.push({ name: stmt.name.text, start: stmt.getFullStart(), end: stmt.getEnd() });
		} else if (ts.isInterfaceDeclaration(stmt)) {
			out.push({ name: stmt.name.text, start: stmt.getFullStart(), end: stmt.getEnd() });
		} else if (ts.isTypeAliasDeclaration(stmt)) {
			out.push({ name: stmt.name.text, start: stmt.getFullStart(), end: stmt.getEnd() });
		} else if (ts.isEnumDeclaration(stmt)) {
			out.push({ name: stmt.name.text, start: stmt.getFullStart(), end: stmt.getEnd() });
		} else if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
			// Multi-declarator statements (`export const a = 1, b = 2;`) are skipped — removing ONE
			// declarator out of a comma list would need its own splice logic, and this concern's
			// mutation set is deliberately simple/robust over feature-complete.
			const decl = stmt.declarationList.declarations[0]!;
			if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.text, start: stmt.getFullStart(), end: stmt.getEnd() });
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

function synthesizeExportRemoval(sf: ts.SourceFile, input: SynthesizeInput): SynthesizeResult {
	const candidates = findExportRemovalCandidates(sf);
	const target = pick(candidates, input.seed);
	if (!target) return { ok: false, reason: "no removable exported declaration found — export-removal is inapplicable to this file" };
	const candidateContent = splice(input.sourceContent, target.start, target.end, "");
	return finish(input, candidateContent, `removed exported declaration "${target.name}" entirely — EXPORTS_REMOVED`);
}

// ── inheritance-change ──────────────────────────────────────────────────────────────────────────────

interface HeritageCandidate {
	name: string;
	insertAt: number;
	replacement: string;
	detail: string;
}

function findInheritanceChangeCandidates(sf: ts.SourceFile): HeritageCandidate[] {
	const out: HeritageCandidate[] = [];
	for (const stmt of sf.statements) {
		if (!hasExportModifier(stmt)) continue;
		if (!ts.isClassDeclaration(stmt) && !ts.isInterfaceDeclaration(stmt)) continue;
		if (!stmt.name) continue;
		const extendsClause = (stmt.heritageClauses ?? []).find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
		if (extendsClause && extendsClause.types.length > 0) {
			const targetType = extendsClause.types[0]!;
			out.push({
				name: stmt.name.text,
				insertAt: targetType.getEnd(),
				replacement: "_Synth",
				detail: `renamed extends target of "${stmt.name.text}" by appending "_Synth"`,
			});
		} else {
			out.push({
				name: stmt.name.text,
				insertAt: stmt.name.getEnd(),
				replacement: " extends __SynthBase",
				detail: `added "extends __SynthBase" to "${stmt.name.text}"`,
			});
		}
	}
	return out.sort((a, b) => a.insertAt - b.insertAt);
}

function synthesizeInheritanceChange(sf: ts.SourceFile, input: SynthesizeInput): SynthesizeResult {
	const candidates = findInheritanceChangeCandidates(sf);
	const target = pick(candidates, input.seed);
	if (!target) return { ok: false, reason: "no exported class or interface found — inheritance-change is inapplicable to this file" };
	const candidateContent = splice(input.sourceContent, target.insertAt, target.insertAt, target.replacement);
	return finish(input, candidateContent, `${target.detail} — EXTENDS_CHANGED`);
}

// ── adjacent-dependency-edit ────────────────────────────────────────────────────────────────────────

function synthesizeAdjacentDependencyEdit(input: SynthesizeInput): SynthesizeResult {
	// Always applicable (unlike the other three kinds) — every parseable file, even one with zero
	// existing imports, can gain one. The synthetic target path embeds the seed so pairs generated from
	// the same file at different seeds never collide on the same IMPORTS_ADDED specifier.
	const importLine = `import { __synthImportTarget } from "./__synth-adjacent-target-${input.seed}.ts";\n`;
	const candidateContent = importLine + input.sourceContent;
	return finish(input, candidateContent, `prepended a new relative import "./__synth-adjacent-target-${input.seed}.ts" — IMPORTS_ADDED`);
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────────

export function synthesizeMutation(input: SynthesizeInput): SynthesizeResult {
	const parsed = parseSource(input.sourcePath, input.sourceContent);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	switch (input.kind) {
		case "signature-change":
			return synthesizeSignatureChange(parsed.sf, input);
		case "export-removal":
			return synthesizeExportRemoval(parsed.sf, input);
		case "inheritance-change":
			return synthesizeInheritanceChange(parsed.sf, input);
		case "adjacent-dependency-edit":
			return synthesizeAdjacentDependencyEdit(input);
	}
}

// ── batch generation over a real file set ───────────────────────────────────────────────────────────

export interface SyntheticCorpusFile {
	sourcePath: string;
	sourceContent: string;
}

export interface SyntheticCorpusCoverage {
	kind: SyntheticMutationKind;
	attempted: number;
	recovered: number;
	gaps: Array<{ sourcePath: string; reason: string }>;
}

export interface SyntheticCorpus {
	pairs: SyntheticPair[];
	coverage: SyntheticCorpusCoverage[];
}

/**
 * Attempt every (file, kind) combination, seeding each with `seedBase + fileIndex` — deterministic
 * across runs given the same `files` order and `seedBase`. An inapplicable combination (e.g. a file
 * with no exported function for `signature-change`) is reported as a gap, never silently dropped —
 * mirrors `corpus.ts`'s own multidimensional coverage discipline.
 */
export function generateSyntheticCorpus(files: readonly SyntheticCorpusFile[], seedBase = 0): SyntheticCorpus {
	const pairs: SyntheticPair[] = [];
	const coverageByKind = new Map<SyntheticMutationKind, SyntheticCorpusCoverage>();
	for (const kind of SYNTHETIC_MUTATION_KINDS) coverageByKind.set(kind, { kind, attempted: 0, recovered: 0, gaps: [] });
	files.forEach((file, fileIndex) => {
		for (const kind of SYNTHETIC_MUTATION_KINDS) {
			const cov = coverageByKind.get(kind)!;
			cov.attempted++;
			const result = synthesizeMutation({ sourcePath: file.sourcePath, sourceContent: file.sourceContent, kind, seed: seedBase + fileIndex });
			if (result.ok) {
				pairs.push(result.pair);
				cov.recovered++;
			} else {
				cov.gaps.push({ sourcePath: file.sourcePath, reason: result.reason });
			}
		}
	});
	return { pairs, coverage: [...coverageByKind.values()] };
}
