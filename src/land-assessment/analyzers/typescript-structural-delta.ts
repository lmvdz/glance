/**
 * TypeScript structural-delta analyzer (concern 04, `plans/land-assessment/04-structural-delta-analyzer.md`)
 * — per-file SYNTACTIC AST deltas for B→M (base→main) and B→C (base→candidate), plus overlap/adjacency
 * joins between the two sides. Owns the two claimed classes `structural-api`/`dependency`
 * (`incident-taxonomy.ts`'s `CLAIMED_BY`) — DESIGN.md's Risks section is explicit that this analyzer has
 * ~0 REAL labeled positives in the replay corpus (topology carries the wedge's go/no-go evidence), so
 * every fixture below is synthetic and labeled as such rather than presented as validated recall.
 *
 * Syntactic only — the arbitrated decision (DESIGN.md decision 1; in-repo precedent
 * `scripts/dead-exports.ts`): file content via `git show <commit>:<path>` (no checkouts, no
 * `node_modules`, no tsconfig, no `ts.createProgram`), parsed with `ts.createSourceFile`. Changed-file
 * lists come from `git diff --name-status -M <A> <B>` — the `-M` output IS the rename evidence; a
 * split/ambiguous rename (the same source path claimed by more than one `R` line — defensive, real git
 * rarely emits this since its matcher is 1:1, but never guessed at) degrades to add+remove plus an
 * unresolved-rename coverage gap, never a guessed identity link.
 *
 * Five detections, each comparing a file's BEFORE (base-side) extraction against its AFTER (this side's)
 * extraction and emitting `SnapshotFact`s in the concern's predicate vocabulary:
 *
 *   EXPORTS_ADDED / EXPORTS_REMOVED   an exported symbol appeared/disappeared, keyed by NAME (not path —
 *                                     a clean rename compares old-path/new-path content under the SAME
 *                                     symbol name, so it never spuriously reads as remove+add; identity
 *                                     is carried by construction, no special-case code needed).
 *   SIGNATURE_CHANGED                 a symbol survives in both sides but its normalized signature text
 *                                     hash differs — `signatureKind` classifies WHAT changed
 *                                     (arity/optionality/generic/type/unresolvable) via
 *                                     `classifySignatureChange`, function-like declarations only;
 *                                     non-function declarations that changed report "unresolvable" —
 *                                     syntax-only genuinely cannot attribute the delta further.
 *   IMPORTS_ADDED / IMPORTS_REMOVED   a file's import/re-export specifier set changed. Relative
 *                                     specifiers are resolved by pure path arithmetic (case-normalized,
 *                                     extension-probed against the commit's OWN tree listing via
 *                                     `git ls-tree`); package specifiers stay opaque nodes — no
 *                                     `ts.resolveModuleName`, per DESIGN.md's documented escalation
 *                                     (not built now).
 *   EXTENDS_CHANGED / IMPLEMENTS_CHANGED  a class/interface's heritage-clause target set changed.
 *
 * `SnapshotFact` (not `ChangeObservation`) is the container for all of the above — `plugin.ts`'s
 * `AnalysisResult.observations` is ALREADY locked to `SnapshotFact[]` by concern 03; SCHEMA-V0.md's own
 * `SnapshotFact.predicate` doc ("EXPORTS | IMPORTS | EXTENDS | IMPLEMENTS | HAS_SIGNATURE | ...") is
 * illustrative, not a closed enum (topology.ts's FORKED_FROM/UNREACHABLE_FROM/etc. are none of those
 * five either), so a delta-shaped predicate (`EXPORTS_ADDED`, `SIGNATURE_CHANGED`, ...) fits the shape:
 * the fact's `state` addresses the exact state the delta was OBSERVED IN (M or C respectively — mirrors
 * topology.ts's own precedent of attaching comparison facts to one side's resulting state).
 *
 * Two findings join the two sides (`derivedFromObservations` lineage, per SCHEMA-V0.md):
 *   concurrentEdits            exact-key intersection of both sides' touched qualifiedName sets —
 *                               DETERMINISTIC (no interpretation beyond set membership).
 *   adjacentDependencyChanges   one side's import-delta edges whose RESOLVED target file was touched
 *                               (export/signature/heritage change) on the OTHER side — DERIVED (an
 *                               inference: "these two changes are near each other", not a raw fact).
 *
 * `extractStateFacts(stateRef)` is the full-state entry point concern 11's manifest/checkpoint anchor
 * reuses — it shares `extractFileFacts`/`resolveSpec` with the delta path so the two never drift into
 * two different notions of "what does this file export".
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import * as ts from "typescript";
import { computeConfigurationHash, computeRepositoryId, EXTRACTOR_VERSION } from "../id.ts";
import { CLAIMED_BY } from "../replay/incident-taxonomy.ts";
import type { AnalysisEnvironmentFingerprint, AssessmentFinding, EntityLocator, ExtractionCoverage, ProducerRef, RepositoryStateRef, SnapshotFact } from "../schema.ts";
import { git, type AnalysisResult, type AnalyzerContext, type AssessmentAnalyzer } from "./plugin.ts";

const PRODUCER: ProducerRef = { name: "typescript-structural-delta", version: EXTRACTOR_VERSION };

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
/** Extension-probe order for relative-specifier resolution — bare match first (an explicit extension
 *  in the specifier itself), then each real TS extension, then each `index` barrel form. */
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.mts", "/index.cts"];

/** "Do a full, honest run, or gap the whole side — never a partial silent run" (the concern's Approach).
 *  500 is the concern's own stated default. */
export const DEFAULT_SIZE_CAP = 500;

function isTsPath(p: string): boolean {
	const lower = p.toLowerCase();
	return TS_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function stableId(...parts: string[]): string {
	return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function dottedModulePath(filePath: string): string {
	return filePath.replace(/\.(ts|tsx|mts|cts)$/i, "").split("/").join(".");
}

function dottedExportPathFor(filePath: string, name: string): string {
	return `${dottedModulePath(filePath)}.${name}`;
}

// ── git content access ──────────────────────────────────────────────────────────────────────────────

/** `undefined` when the file does not exist at `commit` (deleted, or not yet added) — NOT an error;
 *  callers decide whether that absence is expected (an "added"/"removed" diff entry) or an anomaly. */
async function readFileAtCommit(repo: string, commit: string, filePath: string): Promise<string | undefined> {
	const r = await git(["show", `${commit}:${filePath}`], repo);
	if (r.code !== 0) return undefined;
	return r.stdout;
}

async function listTreePaths(repo: string, commit: string): Promise<Set<string>> {
	const r = await git(["ls-tree", "-r", "--name-only", commit], repo);
	if (r.code !== 0 || !r.stdout) return new Set();
	return new Set(r.stdout.split("\n").filter(Boolean));
}

// ── changed-file diff (rename-aware) ────────────────────────────────────────────────────────────────

export type DiffOperation = "added" | "removed" | "modified" | "renamed";

export interface DiffEntry {
	operation: DiffOperation;
	/** The path relevant to display/lookup at THIS side's commit — the deleted path for "removed", the
	 *  new path for "renamed"/"added"/"modified". */
	path: string;
	/** Only set for an unambiguous rename — the pre-rename path, used to fetch BEFORE content. */
	fromPath?: string;
}

export interface DiffParseResult {
	entries: DiffEntry[];
	/** One reason string per ambiguous/split rename source — surfaced as coverage gaps, never silently
	 *  absorbed into a guessed identity link. */
	ambiguousRenameGaps: string[];
}

/** Parses `git diff --name-status -M` porcelain output. Exported (pure, no I/O) so the ambiguous/split
 *  rename path — real git's 1:1 matcher rarely produces it — can be exercised directly with crafted
 *  input rather than fighting git into an edge case it may never actually emit.
 *  @substrate Phase-1 producer (concern 04) with no external caller yet -- the land hook (concern 08)
 *  and offline replay CLI wire the analyzer up in later batches (plans/land-assessment); a co-located
 *  test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function parseNameStatus(output: string): DiffParseResult {
	const rows: Array<{ status: string; parts: string[] }> = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		rows.push({ status: line.split("\t")[0]!, parts: line.split("\t") });
	}
	const renameSourceCounts = new Map<string, number>();
	for (const { status, parts } of rows) {
		if (status.startsWith("R") && parts.length >= 3) {
			renameSourceCounts.set(parts[1]!, (renameSourceCounts.get(parts[1]!) ?? 0) + 1);
		}
	}
	const entries: DiffEntry[] = [];
	const ambiguousRenameGaps: string[] = [];
	const removedForAmbiguousSource = new Set<string>(); // emit the "removed" half ONCE per split source, not once per destination
	for (const { status, parts } of rows) {
		if (status === "A" && parts.length >= 2) {
			entries.push({ operation: "added", path: parts[1]! });
		} else if (status === "D" && parts.length >= 2) {
			entries.push({ operation: "removed", path: parts[1]! });
		} else if (status === "M" && parts.length >= 2) {
			entries.push({ operation: "modified", path: parts[1]! });
		} else if (status.startsWith("R") && parts.length >= 3) {
			const fromPath = parts[1]!;
			const toPath = parts[2]!;
			if ((renameSourceCounts.get(fromPath) ?? 0) > 1) {
				if (!removedForAmbiguousSource.has(fromPath)) {
					removedForAmbiguousSource.add(fromPath);
					ambiguousRenameGaps.push(
						`possible rename, unresolved: ${fromPath} -> multiple destinations (${renameSourceCounts.get(fromPath)} candidates) — treated as add+remove, never a guessed identity link`,
					);
					entries.push({ operation: "removed", path: fromPath });
				}
				entries.push({ operation: "added", path: toPath });
			} else {
				entries.push({ operation: "renamed", path: toPath, fromPath });
			}
		} else if (status.startsWith("C") && parts.length >= 3) {
			// Copy (only emitted with -C, which this analyzer does not pass) — defensive: treat the
			// destination as an addition, the source is untouched.
			entries.push({ operation: "added", path: parts[2]! });
		}
	}
	return { entries, ambiguousRenameGaps };
}

interface DiffFetchResult extends DiffParseResult {
	probeFailed: boolean;
	probeError?: string;
}

async function diffChangedFiles(repo: string, fromCommit: string, toCommit: string): Promise<DiffFetchResult> {
	const r = await git(["diff", "--name-status", "-M", fromCommit, toCommit], repo);
	if (r.code !== 0) return { entries: [], ambiguousRenameGaps: [], probeFailed: true, probeError: r.stderr || r.stdout || "no output" };
	return { ...parseNameStatus(r.stdout), probeFailed: false };
}

// ── per-file extraction ─────────────────────────────────────────────────────────────────────────────

export type DeclarationKind = "function" | "function-const" | "class" | "interface" | "type-alias" | "enum" | "const" | "re-export";
export type SignatureKind = "type-changed" | "arity-changed" | "optionality-changed" | "generic-changed" | "unresolvable";

interface FunctionShape {
	arity: number;
	optionalFlags: boolean[];
	typeParams: string[];
}

interface ExportEntry {
	name: string;
	kind: DeclarationKind;
	dottedExportPath: string;
	signatureText: string;
	signatureHash: string;
	/** Present only for function-like declarations (function/function-const) — the structural pieces
	 *  `classifySignatureChange` compares to attribute WHAT changed. */
	functionShape?: FunctionShape;
}

interface HeritageEntry {
	subject: string;
	kind: "extends" | "implements";
	targets: string[]; // sorted, normalized type texts
}

interface FileExtraction {
	exports: ExportEntry[]; // sorted by name
	importSpecifiers: string[]; // sorted, deduped, raw specifier text
	heritage: HeritageEntry[]; // sorted by subject
}

type ParseOutcome = { ok: true; extraction: FileExtraction } | { ok: false; reason: string };

function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
	return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function functionShapeOf(node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): FunctionShape {
	return {
		arity: node.parameters.length,
		optionalFlags: node.parameters.map((p) => Boolean(p.questionToken) || Boolean(p.initializer)),
		typeParams: (node.typeParameters ?? []).map((tp) => tp.name.text).sort(),
	};
}

function functionSignatureText(node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile): string {
	const typeParamsText = node.typeParameters?.length ? `<${node.typeParameters.map((tp) => tp.getText(sf)).join(", ")}>` : "";
	const paramsText = node.parameters.map((p) => p.getText(sf)).join(", ");
	const returnText = node.type ? node.type.getText(sf) : "";
	return normalizeText(`${typeParamsText}(${paramsText})${returnText ? `: ${returnText}` : ""}`);
}

/** Text of a class/interface/enum declaration UP TO its opening body brace — deliberately excludes the
 *  body (a method body edit is not a "signature" change), normalized whitespace. Known imprecision: a
 *  generic constraint containing an object-literal type (`<T extends { x: number }>`) embeds an earlier
 *  `{`, truncating the header early; rare, and the resulting signature text is still deterministic (just
 *  coarser), never wrong in a way that fabricates a finding. */
function headerTextBeforeBody(node: ts.Node, sf: ts.SourceFile): string {
	const fullText = node.getText(sf);
	const braceIdx = fullText.indexOf("{");
	return braceIdx >= 0 ? fullText.slice(0, braceIdx) : fullText;
}

function collectHeritage(node: ts.ClassDeclaration | ts.InterfaceDeclaration, subject: string, sf: ts.SourceFile, out: HeritageEntry[]): void {
	const extendsTargets: string[] = [];
	const implementsTargets: string[] = [];
	for (const clause of node.heritageClauses ?? []) {
		const targets = clause.types.map((t) => normalizeText(t.getText(sf)));
		if (clause.token === ts.SyntaxKind.ExtendsKeyword) extendsTargets.push(...targets);
		else if (clause.token === ts.SyntaxKind.ImplementsKeyword) implementsTargets.push(...targets);
	}
	if (extendsTargets.length > 0) out.push({ subject, kind: "extends", targets: extendsTargets.sort() });
	if (implementsTargets.length > 0) out.push({ subject, kind: "implements", targets: implementsTargets.sort() });
}

/** `sf.parseDiagnostics` is an internal (non-`.d.ts`) field TypeScript's own parser always populates —
 *  the standard technique tooling uses to detect syntax errors from `ts.createSourceFile` alone, without
 *  a full `ts.createProgram`/`getPreEmitDiagnostics` pass (which decision 1 rejected). Cast is
 *  deliberate and documented, not an accident. */
function parseDiagnosticsOf(sf: ts.SourceFile): readonly ts.Diagnostic[] {
	return (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

function diagnosticMessage(d: ts.Diagnostic): string {
	return typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
}

/** Per-file extraction shared by BOTH the delta path (`computeSideDelta`) and the full-state anchor path
 *  (`extractStateFacts`) — the concern's explicit requirement that the two never diverge into separate
 *  notions of "what does this file export". NUL-byte content is treated as binary, never handed to the
 *  parser; genuine syntax errors are read off `parseDiagnostics` rather than guessed at. */
function extractFileFacts(filePath: string, text: string): ParseOutcome {
	if (text.includes("\0")) return { ok: false, reason: "binary-content: file contains a NUL byte" };
	const scriptKind = filePath.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
	const diagnostics = parseDiagnosticsOf(sf);
	if (diagnostics.length > 0) return { ok: false, reason: `parse-error: ${diagnosticMessage(diagnostics[0]!)}` };

	const exports: ExportEntry[] = [];
	const importSpecifiers = new Set<string>();
	const heritage: HeritageEntry[] = [];

	function addExport(name: string, kind: DeclarationKind, node: ts.Node): void {
		const dottedExportPath = dottedExportPathFor(filePath, name);
		let signatureText: string;
		let functionShape: FunctionShape | undefined;
		if (isFunctionLike(node)) {
			signatureText = functionSignatureText(node, sf);
			functionShape = functionShapeOf(node);
		} else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
			signatureText = normalizeText(headerTextBeforeBody(node, sf));
		} else {
			signatureText = normalizeText(node.getText(sf));
		}
		exports.push({ name, kind, dottedExportPath, signatureText, signatureHash: sha1(signatureText), functionShape });
	}

	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) {
			if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) importSpecifiers.add(stmt.moduleSpecifier.text);
			continue;
		}
		if (ts.isExportDeclaration(stmt)) {
			if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) importSpecifiers.add(stmt.moduleSpecifier.text); // re-export = a dependency edge too
			if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
				for (const el of stmt.exportClause.elements) addExport(el.name.text, "re-export", el);
			}
			continue;
		}
		const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
		const hasExportModifier = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
		if (!hasExportModifier) continue;

		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			addExport(stmt.name.text, "function", stmt);
		} else if (ts.isClassDeclaration(stmt) && stmt.name) {
			addExport(stmt.name.text, "class", stmt);
			collectHeritage(stmt, stmt.name.text, sf, heritage);
		} else if (ts.isInterfaceDeclaration(stmt)) {
			addExport(stmt.name.text, "interface", stmt);
			collectHeritage(stmt, stmt.name.text, sf, heritage);
		} else if (ts.isTypeAliasDeclaration(stmt)) {
			addExport(stmt.name.text, "type-alias", stmt);
		} else if (ts.isEnumDeclaration(stmt)) {
			addExport(stmt.name.text, "enum", stmt);
		} else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name)) continue; // destructuring export bindings: no single stable name, skip
				if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
					addExport(decl.name.text, "function-const", decl.initializer);
				} else {
					addExport(decl.name.text, "const", decl);
				}
			}
		}
		// `export default <anonymous>` (no name to key identity on) is intentionally not tracked.
	}

	exports.sort((a, b) => a.name.localeCompare(b.name));
	heritage.sort((a, b) => a.subject.localeCompare(b.subject));
	return { ok: true, extraction: { exports, importSpecifiers: [...importSpecifiers].sort(), heritage } };
}

// ── module resolution (relative specifiers only — package specifiers stay opaque) ──────────────────

function isRelativeSpecifier(spec: string): boolean {
	return spec.startsWith(".") || spec.startsWith("/");
}

function resolveRelativeSpecifier(fromFilePath: string, specifier: string, lowerTree: ReadonlyMap<string, string>): string | undefined {
	const dir = path.posix.dirname(fromFilePath);
	const joined = path.posix.normalize(path.posix.join(dir, specifier));
	for (const suffix of RESOLVE_SUFFIXES) {
		const hit = lowerTree.get(`${joined}${suffix}`.toLowerCase());
		if (hit) return hit;
	}
	return undefined;
}

/** `attempted: false` for a package specifier — deliberately opaque (DESIGN.md), never counted as an
 *  unresolved gap. `attempted: true, resolvedPath: undefined` is a genuine resolution miss. */
function resolveSpec(fromFilePath: string, specifier: string, lowerTree: ReadonlyMap<string, string>): { resolvedPath?: string; attempted: boolean } {
	if (!isRelativeSpecifier(specifier)) return { attempted: false };
	return { resolvedPath: resolveRelativeSpecifier(fromFilePath, specifier, lowerTree), attempted: true };
}

function buildLowerTree(tree: ReadonlySet<string>): Map<string, string> {
	const lower = new Map<string, string>();
	for (const p of tree) lower.set(p.toLowerCase(), p);
	return lower;
}

// ── signature-change classification ─────────────────────────────────────────────────────────────────

/** `before`/`after` are the SAME symbol name on either side of a change. Function-like on both sides:
 *  structurally attributed (arity > optionality > generics > "everything else" priority, matching the
 *  concern's fixed vocabulary). Anything else — a kind change, or a non-function declaration whose text
 *  changed — is `"unresolvable"`: syntax-only genuinely cannot say more without a type checker. */
function classifySignatureChange(before: ExportEntry, after: ExportEntry): SignatureKind {
	if (before.functionShape && after.functionShape) {
		if (before.functionShape.arity !== after.functionShape.arity) return "arity-changed";
		if (JSON.stringify(before.functionShape.optionalFlags) !== JSON.stringify(after.functionShape.optionalFlags)) return "optionality-changed";
		if (JSON.stringify(before.functionShape.typeParams) !== JSON.stringify(after.functionShape.typeParams)) return "generic-changed";
		return "type-changed";
	}
	return "unresolvable";
}

// ── fact builders ────────────────────────────────────────────────────────────────────────────────────

function evidenceFor(repo: string, commit: string, filePath: string) {
	return [{ kind: "commit-file" as const, repositoryId: repo, commit, path: filePath }];
}

function exportFact(predicate: "EXPORTS_ADDED" | "EXPORTS_REMOVED", state: RepositoryStateRef, repo: string, filePath: string, exp: ExportEntry, observedAt: string): SnapshotFact {
	return {
		factId: stableId("structural-delta", predicate, exp.dottedExportPath, state.commit),
		state,
		subject: { qualifiedName: exp.dottedExportPath, path: filePath, kind: exp.kind },
		predicate,
		object: { kind: "string", value: exp.signatureHash },
		authority: "deterministic",
		observedAt,
		producer: PRODUCER,
		evidence: evidenceFor(repo, state.commit, filePath),
	};
}

function signatureChangedFact(state: RepositoryStateRef, repo: string, filePath: string, before: ExportEntry, after: ExportEntry, signatureKind: SignatureKind, observedAt: string): SnapshotFact {
	return {
		factId: stableId("structural-delta", "SIGNATURE_CHANGED", after.dottedExportPath, state.commit),
		state,
		subject: { qualifiedName: after.dottedExportPath, path: filePath, kind: after.kind },
		predicate: "SIGNATURE_CHANGED",
		object: { kind: "json", value: { signatureKind, before: before.signatureText, after: after.signatureText } },
		authority: "deterministic",
		observedAt,
		producer: PRODUCER,
		evidence: evidenceFor(repo, state.commit, filePath),
	};
}

function importFact(predicate: "IMPORTS_ADDED" | "IMPORTS_REMOVED", state: RepositoryStateRef, repo: string, filePath: string, specifier: string, resolvedPath: string | undefined, observedAt: string): SnapshotFact {
	return {
		factId: stableId("structural-delta", predicate, filePath, specifier, state.commit),
		state,
		subject: { qualifiedName: dottedModulePath(filePath), path: filePath, kind: "module" },
		predicate,
		object: { kind: "string", value: resolvedPath ?? specifier },
		authority: "deterministic",
		observedAt,
		producer: PRODUCER,
		evidence: evidenceFor(repo, state.commit, filePath),
	};
}

function heritageChangedFact(state: RepositoryStateRef, repo: string, filePath: string, subject: string, kind: "extends" | "implements", before: string[], after: string[], observedAt: string): SnapshotFact {
	const predicate = kind === "extends" ? "EXTENDS_CHANGED" : "IMPLEMENTS_CHANGED";
	return {
		factId: stableId("structural-delta", predicate, filePath, subject, state.commit),
		state,
		subject: { qualifiedName: dottedExportPathFor(filePath, subject), path: filePath, kind: "class-or-interface" },
		predicate,
		object: { kind: "json", value: { before, after } },
		authority: "deterministic",
		observedAt,
		producer: PRODUCER,
		evidence: evidenceFor(repo, state.commit, filePath),
	};
}

// ── one side's delta (B→M or B→C) ───────────────────────────────────────────────────────────────────

interface ImportEdge {
	file: string;
	target: string;
	operation: "added" | "removed";
	factId: string;
}

interface SideDelta {
	facts: SnapshotFact[];
	coverage: ExtractionCoverage[];
	/** Files with ANY export/signature/heritage change on this side — the join key for adjacency. */
	touchedFiles: Set<string>;
	/** `qualifiedName`s (dotted export paths) touched (added/removed/signature-changed) on this side —
	 *  the exact-key join set for `concurrentEdits`. */
	touchedSymbols: Set<string>;
	/** Import-delta edges whose target RESOLVED to an in-repo file — the join set for
	 *  `adjacentDependencyChanges`. Package-specifier edges (unresolved) never participate. */
	importEdges: ImportEdge[];
}

async function computeSideDelta(repo: string, baseCommit: string, otherCommit: string, sideState: RepositoryStateRef, treeCache: Map<string, Promise<Set<string>>>, observedAt: string): Promise<SideDelta> {
	const diff = await diffChangedFiles(repo, baseCommit, otherCommit);
	const empty = (): SideDelta => ({ facts: [], coverage: [], touchedFiles: new Set(), touchedSymbols: new Set(), importEdges: [] });

	if (diff.probeFailed) {
		return { ...empty(), coverage: [{ dimension: "syntax", covered: 0, total: 1, gaps: [{ reason: `diff probe failed: ${diff.probeError}` }] }] };
	}
	if (diff.entries.length > DEFAULT_SIZE_CAP) {
		return {
			...empty(),
			coverage: [{ dimension: "syntax", covered: 0, total: diff.entries.length, gaps: [{ reason: `size-cap-exceeded: ${diff.entries.length} changed files exceeds the cap of ${DEFAULT_SIZE_CAP} — not a partial run` }] }],
		};
	}

	let treePromise = treeCache.get(otherCommit);
	if (!treePromise) {
		treePromise = listTreePaths(repo, otherCommit);
		treeCache.set(otherCommit, treePromise);
	}
	const lowerTree = buildLowerTree(await treePromise);

	const facts: SnapshotFact[] = [];
	const touchedFiles = new Set<string>();
	const touchedSymbols = new Set<string>();
	const importEdges: ImportEdge[] = [];
	const syntaxGaps: ExtractionCoverage["gaps"] = diff.ambiguousRenameGaps.map((reason) => ({ reason }));
	const resolutionGaps: ExtractionCoverage["gaps"] = [];
	let syntaxCovered = 0;
	let syntaxTotal = 0;
	let resolutionCovered = 0;
	let resolutionTotal = 0;

	for (const entry of diff.entries) {
		syntaxTotal++;
		const displayPath = entry.path;
		if (!isTsPath(displayPath)) {
			syntaxGaps.push({ path: displayPath, reason: "non-ts-extension" });
			continue;
		}
		const beforePath = entry.operation === "renamed" ? entry.fromPath! : displayPath;

		const beforeText = entry.operation === "added" ? undefined : await readFileAtCommit(repo, baseCommit, beforePath);
		if (entry.operation !== "added" && beforeText === undefined) {
			syntaxGaps.push({ path: beforePath, reason: `unreadable at ${baseCommit}` });
			continue;
		}
		const afterText = entry.operation === "removed" ? undefined : await readFileAtCommit(repo, otherCommit, displayPath);
		if (entry.operation !== "removed" && afterText === undefined) {
			syntaxGaps.push({ path: displayPath, reason: `unreadable at ${otherCommit}` });
			continue;
		}

		const beforeOutcome = beforeText !== undefined ? extractFileFacts(beforePath, beforeText) : undefined;
		if (beforeOutcome && !beforeOutcome.ok) {
			syntaxGaps.push({ path: beforePath, reason: beforeOutcome.reason });
			continue;
		}
		const afterOutcome = afterText !== undefined ? extractFileFacts(displayPath, afterText) : undefined;
		if (afterOutcome && !afterOutcome.ok) {
			syntaxGaps.push({ path: displayPath, reason: afterOutcome.reason });
			continue;
		}
		syntaxCovered++;

		const beforeExports = new Map((beforeOutcome?.extraction.exports ?? []).map((e) => [e.name, e]));
		const afterExports = new Map((afterOutcome?.extraction.exports ?? []).map((e) => [e.name, e]));

		for (const [name, exp] of afterExports) {
			if (beforeExports.has(name)) continue;
			facts.push(exportFact("EXPORTS_ADDED", sideState, repo, displayPath, exp, observedAt));
			touchedFiles.add(displayPath);
			touchedSymbols.add(exp.dottedExportPath);
		}
		for (const [name, exp] of beforeExports) {
			if (afterExports.has(name)) continue;
			facts.push(exportFact("EXPORTS_REMOVED", sideState, repo, beforePath, exp, observedAt));
			touchedFiles.add(displayPath);
			touchedSymbols.add(exp.dottedExportPath);
		}
		for (const [name, afterExp] of afterExports) {
			const beforeExp = beforeExports.get(name);
			if (!beforeExp || beforeExp.signatureHash === afterExp.signatureHash) continue;
			const signatureKind = classifySignatureChange(beforeExp, afterExp);
			facts.push(signatureChangedFact(sideState, repo, displayPath, beforeExp, afterExp, signatureKind, observedAt));
			touchedFiles.add(displayPath);
			touchedSymbols.add(afterExp.dottedExportPath);
		}

		const beforeSpecs = new Set(beforeOutcome?.extraction.importSpecifiers ?? []);
		const afterSpecs = new Set(afterOutcome?.extraction.importSpecifiers ?? []);
		for (const spec of afterSpecs) {
			if (beforeSpecs.has(spec)) continue;
			const { resolvedPath, attempted } = resolveSpec(displayPath, spec, lowerTree);
			if (attempted) {
				resolutionTotal++;
				if (resolvedPath) resolutionCovered++;
				else resolutionGaps.push({ path: displayPath, reason: `resolution: could not resolve relative specifier "${spec}"` });
			}
			const fact = importFact("IMPORTS_ADDED", sideState, repo, displayPath, spec, resolvedPath, observedAt);
			facts.push(fact);
			touchedFiles.add(displayPath);
			if (resolvedPath) importEdges.push({ file: displayPath, target: resolvedPath, operation: "added", factId: fact.factId });
		}
		for (const spec of beforeSpecs) {
			if (afterSpecs.has(spec)) continue;
			const { resolvedPath, attempted } = resolveSpec(beforePath, spec, lowerTree);
			if (attempted) {
				resolutionTotal++;
				if (resolvedPath) resolutionCovered++;
				else resolutionGaps.push({ path: beforePath, reason: `resolution: could not resolve relative specifier "${spec}"` });
			}
			const fact = importFact("IMPORTS_REMOVED", sideState, repo, beforePath, spec, resolvedPath, observedAt);
			facts.push(fact);
			touchedFiles.add(displayPath);
			if (resolvedPath) importEdges.push({ file: beforePath, target: resolvedPath, operation: "removed", factId: fact.factId });
		}

		const beforeHeritage = new Map((beforeOutcome?.extraction.heritage ?? []).map((h) => [`${h.subject}\0${h.kind}`, h]));
		const afterHeritage = new Map((afterOutcome?.extraction.heritage ?? []).map((h) => [`${h.subject}\0${h.kind}`, h]));
		for (const key of new Set([...beforeHeritage.keys(), ...afterHeritage.keys()])) {
			const beforeTargets = beforeHeritage.get(key)?.targets ?? [];
			const afterTargets = afterHeritage.get(key)?.targets ?? [];
			if (JSON.stringify(beforeTargets) === JSON.stringify(afterTargets)) continue;
			const [subject, kindStr] = key.split("\0") as [string, "extends" | "implements"];
			facts.push(heritageChangedFact(sideState, repo, displayPath, subject, kindStr, beforeTargets, afterTargets, observedAt));
			touchedFiles.add(displayPath);
		}
	}

	const coverage: ExtractionCoverage[] = [
		{ dimension: "syntax", covered: syntaxCovered, total: syntaxTotal, gaps: syntaxGaps },
		{ dimension: "resolution", covered: resolutionCovered, total: resolutionTotal, gaps: resolutionGaps },
		{ dimension: "type", covered: 0, total: syntaxTotal, gaps: [{ reason: "type-checking not performed in v0 (syntax-only mode)" }] },
	];
	return { facts, coverage, touchedFiles, touchedSymbols, importEdges };
}

// ── joins (findings) ─────────────────────────────────────────────────────────────────────────────────

function buildConcurrentEditsFinding(mainSide: SideDelta, candidateSide: SideDelta, repo: string, candidateState: RepositoryStateRef): AssessmentFinding | undefined {
	const shared = [...mainSide.touchedSymbols].filter((s) => candidateSide.touchedSymbols.has(s)).sort();
	if (shared.length === 0) return undefined;
	const sharedSet = new Set(shared);
	const derivedFrom = [...mainSide.facts, ...candidateSide.facts]
		.filter((f) => sharedSet.has(f.subject.qualifiedName))
		.map((f) => f.factId)
		.sort();
	const shown = shared.slice(0, 8);
	const more = shared.length > shown.length ? ` (+${shared.length - shown.length} more)` : "";
	return {
		id: stableId("structural-delta", "concurrent-edits", candidateState.commit, ...shared),
		kind: "structural-delta.concurrent-edits",
		statement: `${shared.length} symbol(s) were touched on BOTH main (B→M) and candidate (B→C): ${shown.join(", ")}${more} — same-symbol concurrent edit`,
		semantics: { authority: "deterministic", support: "supported", stateRole: "candidate", attemptDisposition: "pending" },
		coverage: { dimension: "syntax", covered: shared.length, total: shared.length, gaps: [] },
		derivedFromObservations: derivedFrom,
		evidence: [{ kind: "commit", repositoryId: repo, commit: candidateState.commit }],
		producer: PRODUCER,
	};
}

function buildAdjacentDependencyFinding(mainSide: SideDelta, candidateSide: SideDelta, repo: string, candidateState: RepositoryStateRef): AssessmentFinding | undefined {
	const fromMain = mainSide.importEdges.filter((e) => candidateSide.touchedFiles.has(e.target));
	const fromCandidate = candidateSide.importEdges.filter((e) => mainSide.touchedFiles.has(e.target));
	const all = [...fromMain, ...fromCandidate];
	if (all.length === 0) return undefined;
	const dedup = [...new Map(all.map((e) => [`${e.file}\0${e.target}`, e])).values()].sort((a, b) => (a.file + a.target).localeCompare(b.file + b.target));
	const shown = dedup.slice(0, 8).map((e) => `${e.file}→${e.target}`);
	const more = dedup.length > shown.length ? ` (+${dedup.length - shown.length} more)` : "";
	return {
		id: stableId("structural-delta", "adjacent-dependency-changes", candidateState.commit, ...dedup.map((e) => `${e.file}>${e.target}`)),
		kind: "structural-delta.adjacent-dependency-changes",
		statement: `${dedup.length} dependency edge(s) changed on one side while their resolved target file was touched on the other side: ${shown.join(", ")}${more} — adjacent-dependency edit`,
		semantics: { authority: "derived", support: "supported", stateRole: "candidate", attemptDisposition: "pending" },
		coverage: { dimension: "resolution", covered: dedup.length, total: dedup.length, gaps: [] },
		derivedFromObservations: [...new Set(dedup.map((e) => e.factId))].sort(),
		evidence: [{ kind: "commit", repositoryId: repo, commit: candidateState.commit }],
		producer: PRODUCER,
	};
}

function mergeCoverage(entries: readonly ExtractionCoverage[]): ExtractionCoverage[] {
	const byDim = new Map<ExtractionCoverage["dimension"], ExtractionCoverage>();
	for (const e of entries) {
		const existing = byDim.get(e.dimension);
		if (!existing) {
			byDim.set(e.dimension, { dimension: e.dimension, covered: e.covered, total: e.total, gaps: [...e.gaps] });
			continue;
		}
		existing.covered += e.covered;
		existing.total += e.total;
		existing.gaps.push(...e.gaps);
	}
	return [...byDim.values()].sort((a, b) => a.dimension.localeCompare(b.dimension));
}

async function stateRefFor(repo: string, commit: string): Promise<RepositoryStateRef> {
	const tree = await git(["rev-parse", `${commit}^{tree}`], repo);
	if (tree.code !== 0 || !tree.stdout) throw new Error(`typescript-structural-delta: could not resolve tree for ${commit}: ${tree.stderr || tree.stdout || "no output"}`);
	return { repositoryId: repo, commit, tree: tree.stdout };
}

function nowIso(): string {
	return new Date().toISOString();
}

// ── full-state extraction (concern 11's manifest/checkpoint anchor) ────────────────────────────────

export interface StateExtraction {
	facts: SnapshotFact[];
	coverage: ExtractionCoverage[];
}

/**
 * Full-state inventory over EVERY TS file at one exact commit — no delta, no comparison, just "what
 * does this repository export/import/extend right now". Shares `extractFileFacts`/`resolveSpec` with
 * the delta path (`computeSideDelta`) by construction, per the concern's explicit requirement that the
 * delta and anchor paths never diverge. Reuses `stateRef.repositoryId` as the git `cwd` — it is ALREADY
 * `computeRepositoryId`-resolved by construction (`id.ts`'s own doc on `RepositoryStateRef`).
 *
 * `filesOverride` (concern 11's `projection.ts`): when given, restricts extraction to exactly those
 * paths instead of every TS file in the tree — the lineage projector uses this to re-extract only the
 * files a delta actually touched, inheriting everything else from the nearest checkpoint, without ever
 * needing a second notion of "what does this file export". `lowerTree`/import resolution are still
 * built from the FULL tree listing regardless of the override, so a restricted run and a full run
 * produce byte-identical per-file output — the override only prunes which files are visited, it never
 * changes how any visited file is extracted.
 */
// @substrate Phase-1 producer (concern 04); concern 11's manifest/checkpoint anchor
// (src/land-assessment/projection.ts) is the override parameter's caller.
export async function extractStateFacts(stateRef: RepositoryStateRef, filesOverride?: readonly string[]): Promise<StateExtraction> {
	const repo = stateRef.repositoryId;
	const observedAt = nowIso();
	const treeSet = await listTreePaths(repo, stateRef.commit);
	const lowerTree = buildLowerTree(treeSet);
	const tsFiles = (filesOverride ?? [...treeSet]).filter(isTsPath).sort();

	const facts: SnapshotFact[] = [];
	const syntaxGaps: ExtractionCoverage["gaps"] = [];
	let syntaxCovered = 0;
	let resolutionCovered = 0;
	let resolutionTotal = 0;

	for (const filePath of tsFiles) {
		const text = await readFileAtCommit(repo, stateRef.commit, filePath);
		if (text === undefined) {
			syntaxGaps.push({ path: filePath, reason: `unreadable at ${stateRef.commit}` });
			continue;
		}
		const outcome = extractFileFacts(filePath, text);
		if (!outcome.ok) {
			syntaxGaps.push({ path: filePath, reason: outcome.reason });
			continue;
		}
		syntaxCovered++;

		for (const exp of outcome.extraction.exports) {
			facts.push({
				factId: stableId("structural-delta", "EXPORTS", exp.dottedExportPath, stateRef.commit),
				state: stateRef,
				subject: { qualifiedName: exp.dottedExportPath, path: filePath, kind: exp.kind },
				predicate: "EXPORTS",
				object: { kind: "string", value: exp.signatureHash },
				authority: "deterministic",
				observedAt,
				producer: PRODUCER,
				evidence: evidenceFor(repo, stateRef.commit, filePath),
			});
			facts.push({
				factId: stableId("structural-delta", "HAS_SIGNATURE", exp.dottedExportPath, stateRef.commit),
				state: stateRef,
				subject: { qualifiedName: exp.dottedExportPath, path: filePath, kind: exp.kind },
				predicate: "HAS_SIGNATURE",
				object: { kind: "signature", value: exp.signatureText },
				authority: "deterministic",
				observedAt,
				producer: PRODUCER,
				evidence: evidenceFor(repo, stateRef.commit, filePath),
			});
		}
		for (const spec of outcome.extraction.importSpecifiers) {
			const { resolvedPath, attempted } = resolveSpec(filePath, spec, lowerTree);
			if (attempted) {
				resolutionTotal++;
				if (resolvedPath) resolutionCovered++;
			}
			facts.push({
				factId: stableId("structural-delta", "IMPORTS", filePath, spec, stateRef.commit),
				state: stateRef,
				subject: { qualifiedName: dottedModulePath(filePath), path: filePath, kind: "module" },
				predicate: "IMPORTS",
				object: { kind: "string", value: resolvedPath ?? spec },
				authority: "deterministic",
				observedAt,
				producer: PRODUCER,
				evidence: evidenceFor(repo, stateRef.commit, filePath),
			});
		}
		for (const h of outcome.extraction.heritage) {
			const predicate = h.kind === "extends" ? "EXTENDS" : "IMPLEMENTS";
			for (const target of h.targets) {
				facts.push({
					factId: stableId("structural-delta", predicate, filePath, h.subject, target, stateRef.commit),
					state: stateRef,
					subject: { qualifiedName: dottedExportPathFor(filePath, h.subject), path: filePath, kind: "class-or-interface" } satisfies EntityLocator,
					predicate,
					object: { kind: "string", value: target },
					authority: "deterministic",
					observedAt,
					producer: PRODUCER,
					evidence: evidenceFor(repo, stateRef.commit, filePath),
				});
			}
		}
	}

	facts.sort((a, b) => a.factId.localeCompare(b.factId));
	const coverage: ExtractionCoverage[] = [
		{ dimension: "syntax", covered: syntaxCovered, total: tsFiles.length, gaps: syntaxGaps },
		{ dimension: "resolution", covered: resolutionCovered, total: resolutionTotal, gaps: [] },
		{ dimension: "type", covered: 0, total: tsFiles.length, gaps: [{ reason: "type-checking not performed in v0 (syntax-only mode)" }] },
	];
	return { facts, coverage };
}

// ── environment fingerprint (SCHEMA-V0.md) ──────────────────────────────────────────────────────────

/**
 * `plugin.ts#AnalysisResult` (already locked by concern 03) carries no `environment` field — the
 * fingerprint an assessment SNAPSHOT needs (SCHEMA-V0.md's `LandAssessmentSnapshot.environment`) is
 * assembled one level up, by the envelope concern 05/08 builds. This function is that analyzer's
 * contribution: pure, deterministic, no I/O beyond reading the bundled `typescript` package's own
 * version string.
 */
// @substrate Phase-1 producer (concern 04) with no external caller yet -- the assessment envelope
// (concern 05/08) wires this into LandAssessmentSnapshot.environment in a later batch
// (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own
// carve-out).
export function structuralDeltaEnvironmentFingerprint(): AnalysisEnvironmentFingerprint {
	const configurationHash = computeConfigurationHash({
		extractorVersion: EXTRACTOR_VERSION,
		mode: "syntax-only",
		typescriptVersion: ts.version,
		sizeCap: DEFAULT_SIZE_CAP,
	});
	return {
		analyzerName: "typescript-structural-delta",
		analyzerVersion: EXTRACTOR_VERSION,
		language: "typescript",
		typescriptVersion: ts.version,
		mode: "syntax-only",
		configurationHash,
	};
}

// ── the analyzer ─────────────────────────────────────────────────────────────────────────────────────

async function applicable(ctx: AnalyzerContext): Promise<boolean> {
	if (!(ctx.repo && ctx.baseCommit && ctx.mainCommit && ctx.candidateCommit)) return false;
	const repo = computeRepositoryId(ctx.repo);
	const [mainDiff, candidateDiff] = await Promise.all([diffChangedFiles(repo, ctx.baseCommit, ctx.mainCommit), diffChangedFiles(repo, ctx.baseCommit, ctx.candidateCommit)]);
	const anyTs = (d: DiffFetchResult) => !d.probeFailed && d.entries.some((e) => isTsPath(e.path) || (e.fromPath !== undefined && isTsPath(e.fromPath)));
	// A repo touching zero TS files on EITHER side is the concern's explicit "analysis key is ABSENT"
	// case — `runAnalyzers` skips a non-applicable analyzer entirely, so no coverage entry is emitted at
	// all (distinct from a file that WAS a TS file but failed to parse, which DOES emit a gap).
	return anyTs(mainDiff) || anyTs(candidateDiff);
}

async function run(ctx: AnalyzerContext): Promise<AnalysisResult> {
	const repo = computeRepositoryId(ctx.repo);
	const resolvedCtx: AnalyzerContext = { ...ctx, repo };
	const observedAt = nowIso(); // one timestamp per analyzer run — all facts/findings from this run share it
	const mainState = await stateRefFor(repo, resolvedCtx.mainCommit);
	const candidateState = await stateRefFor(repo, resolvedCtx.candidateCommit);
	const treeCache = new Map<string, Promise<Set<string>>>();

	const [mainSide, candidateSide] = await Promise.all([
		computeSideDelta(repo, resolvedCtx.baseCommit, resolvedCtx.mainCommit, mainState, treeCache, observedAt),
		computeSideDelta(repo, resolvedCtx.baseCommit, resolvedCtx.candidateCommit, candidateState, treeCache, observedAt),
	]);

	const findings: AssessmentFinding[] = [];
	const concurrent = buildConcurrentEditsFinding(mainSide, candidateSide, repo, candidateState);
	if (concurrent) findings.push(concurrent);
	const adjacent = buildAdjacentDependencyFinding(mainSide, candidateSide, repo, candidateState);
	if (adjacent) findings.push(adjacent);

	const observations = [...mainSide.facts, ...candidateSide.facts].sort((a, b) => a.factId.localeCompare(b.factId));
	findings.sort((a, b) => a.id.localeCompare(b.id));
	const coverage = mergeCoverage([...mainSide.coverage, ...candidateSide.coverage]);
	return { observations, findings, coverage };
}

export const structuralDeltaAnalyzer: AssessmentAnalyzer = {
	name: "typescript-structural-delta",
	version: EXTRACTOR_VERSION,
	claimedClasses: CLAIMED_BY["typescript-structural-delta"],
	applicable,
	run,
};
