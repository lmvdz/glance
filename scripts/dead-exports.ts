/**
 * Dead-export ratchet + inventory.
 *
 * An exported `function`/`const` arrow fn in `src/**\/*.ts` that nothing outside its OWN defining
 * file references is exactly the shape that shipped `openIntervene` with zero callers,
 * `CapabilitySkillSpec` dead-at-spawn, `setGateLogRoot` unwired, and 48 lens tests that never ran
 * (see auto-memory `omp-squad-Agent-Profiles`/`omp-squad-Global-Workspace-research`). A symbol only
 * a TEST imports is the exact same bug wearing a green suite — `tests/**` is deliberately NOT part
 * of the reference universe here.
 *
 * Reference universe: `src/**\/*.ts` (the export sites) plus `webapp/**\/*.ts{,x}` (the only other
 * first-party consumer — the React app imports server types/helpers directly in a few places).
 * Matching is identifier-name existence, not a type-checked import graph: for every exported
 * candidate we ask "does the bare token `name` appear as an IDENTIFIER (never inside a comment or
 * string — the TypeScript scanner classifies those separately, so they're structurally excluded, no
 * regex comment-stripping needed) in any OTHER file in the universe?" This under-counts in one
 * direction only (a same-named, unrelated symbol elsewhere reads as a false "referenced", hiding a
 * real dead export) and never over-counts a live symbol as dead — the safe bias for a ratchet ceiling
 * that gates CI. It is deliberately not a full TS binder/checker pass: that would need a resolved
 * program (tsconfig, path aliases, `webapp`'s separate tsconfig) and a materially longer scan for a
 * check whose whole job is "flag the wildly-obvious zero-reference case", not adjudicate borderline
 * ones.
 *
 * Exemptions (checked in this order):
 *   1. `@substrate <reason>` in the export's doc comment — deliberate built-before-its-caller
 *      substrate (see `plans/eap-borrows/00-overview.md`'s "Follow-ups" for the sanctioned cases).
 *      This is an ESCAPE HATCH, not a rubber stamp: prefer measuring (let it count, lower the
 *      baseline when it's wired up) over annotating away a real dead export.
 *   2. Entrypoint files: `src/index.ts` (its exports are CLI handlers dispatched by a string command
 *      table inside that same file — a cross-file reference scan structurally can't see that) and
 *      `src/*-main.ts` (process entrypoints, invoked by path/bin wiring, not by another module
 *      importing the export). A barrel re-export "consumed elsewhere" needs NO special-case: the
 *      barrel file's own `export { X } from "./foo"` line contains the identifier `X`, so it already
 *      counts as an external reference through the normal scan — no separate exemption list to
 *      maintain or let drift.
 *
 * Run `bun scripts/dead-exports.ts [--files]` for the live report (mirrors
 * `scripts/effect-migration.ts`'s report). `tests/dead-exports-ratchet.test.ts` asserts the live
 * count never EXCEEDS `BASELINE` — new dead code fails the suite; wiring up (or `@substrate`-ing) an
 * existing one and lowering `BASELINE` in the same PR is how the ceiling comes down.
 */
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..");

export interface DeadExport {
	file: string;
	name: string;
	line: number;
	kind: "function" | "arrow";
}

/** Locked ceiling. The live dead-export count must be <= this. Lower it when a symbol gets wired up
 *  or `@substrate`-annotated. Measured 2026-07-10 against the reference universe described above:
 *  723 exported function/const-arrow-fn candidates in src/, 6 exempted as src/index.ts CLI handlers,
 *  3 exempted via `@substrate` (isCostReproducible/detectBaselineStaleness/flagEfficiencyRegression —
 *  plans/eap-borrows/00-overview.md's named follow-ups), 219 with no reference outside their own
 *  defining file.
 *  2026-07-13 (grok harness PR): 218 — parseCodexVerdict left the counted-dead list via an honest
 *  @substrate (exported-for-tests, live caller in-file), and its new grok twin enters exempt the same
 *  way, so the ceiling tightens by one instead of quietly absorbing a new entry. */
/** 2026-07-13 (voice lane PR): 217 — voice-token.ts's voiceModel/voiceProviderIds/voiceVoice were
 *  exported with zero external or test references (pure over-exports); unexported, ceiling tightens. */
/** 2026-07-14 (voice-db-mode secret-store review fixes): 216 — the org_secret substrate
 *  (initMasterKey/hasMasterKey in secrets.ts, appMigrations in migrations.ts, and store.ts's
 *  getOrgSecret/putOrgSecret/deleteOrgSecret/setOrgSecretEnabled) is genuinely built ahead of its
 *  callers — concerns 03 and 05 wire it up in later batches — so each got an honest `@substrate`
 *  tag instead of sitting uncounted; the ceiling still tightens by one net.
 *  2026-07-14 (voice-db-mode concern 03, org-aware resolver): still 216 — `getOrgSecret` left the
 *  `@substrate`-exempt bucket for a REAL one (voice-token.ts's `voiceKeyFor` now imports it), so its
 *  tag was removed rather than left stale; `dead.length` is unaffected either way (it was never
 *  counted as dead, only re-bucketed), so the ceiling doesn't move.
 *  2026-07-14 (voice-db-mode concern 05, admin endpoints): still 216 — `putOrgSecret`/
 *  `deleteOrgSecret`/`setOrgSecretEnabled` left the `@substrate`-exempt bucket the same way, now that
 *  server.ts's four admin routes call all three for real; `dead.length` unaffected, only re-bucketed.
 *  The `org_secret` substrate born in concern 02 is now fully wired end to end.
 *  2026-07-14 (voice-db-mode concern 04 review round 2): 216→215 — `reserveOrgAuditSlot` (the
 *  check-then-act race fix) orphaned `countRecentOrgAudit`, which had zero callers anywhere; deleted
 *  outright rather than tagged `@substrate` since nothing plans to call it. The 216 the prior round
 *  reported was a false green: this deletion made `src/audit.ts`'s `nextAuditId` flip dead→live on
 *  the SAME diff via the raw scanner's comment/backtick fragility, offsetting the real orphan and
 *  holding the total steady — the true count was 217, not 216. Tightening for real this time. */
export const BASELINE = 215;

function scriptKindFor(rel: string): ts.ScriptKind {
	return rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isEntrypoint(file: string): boolean {
	if (file === "src/index.ts") return true;
	return /^src\/[^/]+-main\.ts$/.test(file);
}

/** The comment text (line or block) immediately preceding `node`, or "" when there is none. Read via
 *  `ts.getLeadingCommentRanges` (trivia the scanner classifies as comment, not text a naive
 *  `line.startsWith("//")` regex would have to reconstruct) so `@substrate` inside a `/** ... *\/`
 *  doc comment is found reliably regardless of block-vs-line style or indentation. */
function leadingCommentText(sf: ts.SourceFile, node: ts.Node): string {
	const fullText = sf.getFullText();
	const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? [];
	return ranges.map((r) => fullText.slice(r.pos, r.end)).join("\n");
}

/** Everything after `@substrate` up to end-of-line (and any trailing close-comment marker a block
 *  comment leaves on that line), or undefined when the tag isn't present. */
function extractSubstrate(comment: string): string | undefined {
	const m = comment.match(/@substrate\s+([^\n]+)/);
	if (!m) return undefined;
	return m[1].replace(/\*\/\s*$/, "").trim();
}

interface Candidate {
	file: string;
	name: string;
	line: number;
	kind: "function" | "arrow";
	substrate?: string;
}

/** Top-level exported `function`/`async function` declarations and `const name = (...) => ...` /
 *  `const name = async (...) => ...` arrow-fn declarations in one file. Deliberately narrow (matches
 *  the two canonical export shapes only) — `export class`, `export interface`/`type`, `export
 *  default`, and non-function `export const` are out of scope per the spec this ratchet implements. */
function extractExports(rel: string, text: string): Candidate[] {
	const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindFor(rel));
	const out: Candidate[] = [];
	for (const stmt of sf.statements) {
		const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
		const hasExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
		if (!hasExport) continue;
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			out.push({
				file: rel,
				name: stmt.name.text,
				line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
				kind: "function",
				substrate: extractSubstrate(leadingCommentText(sf, stmt)),
			});
		} else if (ts.isVariableStatement(stmt)) {
			const substrate = extractSubstrate(leadingCommentText(sf, stmt));
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.initializer && ts.isArrowFunction(decl.initializer)) {
					out.push({
						file: rel,
						name: decl.name.text,
						line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
						kind: "arrow",
						substrate,
					});
				}
			}
		}
	}
	return out;
}

/** Every IDENTIFIER token in a file (comments and string/template contents excluded structurally —
 *  the TS scanner never classifies their contents as `SyntaxKind.Identifier`). A set, not a count: this
 *  ratchet only asks "does this name appear anywhere in another file", never "how many times". */
function identifierSet(rel: string, text: string): Set<string> {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, scriptKindFor(rel), text);
	const ids = new Set<string>();
	let tok = scanner.scan();
	while (tok !== ts.SyntaxKind.EndOfFileToken) {
		if (tok === ts.SyntaxKind.Identifier) ids.add(scanner.getTokenText());
		tok = scanner.scan();
	}
	return ids;
}

export interface ScanResult {
	/** All exported function/const-arrow-fn candidates found in src/. */
	total: number;
	/** Exempted as an src/index.ts CLI handler or a src/*-main.ts entrypoint. */
	entrypointExempt: number;
	/** Exempted via a `@substrate <reason>` doc-comment tag. */
	substrateExempt: number;
	/** No reference outside the defining file, not exempt — the count the ratchet gates on. */
	dead: DeadExport[];
}

/** Scan src/ for dead exports against the src/+webapp/ reference universe. Deterministic and
 *  order-independent: file lists are glob-sorted, per-file AST traversal is source order, and the
 *  reference check is a set-membership test (no iteration-order-sensitive scoring). */
export function scan(): ScanResult {
	const srcFiles = [...new Glob("src/**/*.ts").scanSync(REPO_ROOT)].sort();
	const webappFiles = [...new Glob("webapp/**/*.{ts,tsx}").scanSync(REPO_ROOT)].sort();

	const candidates: Candidate[] = [];
	for (const rel of srcFiles) candidates.push(...extractExports(rel, readFileSync(join(REPO_ROOT, rel), "utf8")));

	const idSets = new Map<string, Set<string>>();
	for (const rel of [...srcFiles, ...webappFiles]) idSets.set(rel, identifierSet(rel, readFileSync(join(REPO_ROOT, rel), "utf8")));

	let entrypointExempt = 0;
	let substrateExempt = 0;
	const dead: DeadExport[] = [];
	for (const c of candidates) {
		if (isEntrypoint(c.file)) {
			entrypointExempt++;
			continue;
		}
		if (c.substrate) {
			substrateExempt++;
			continue;
		}
		let referenced = false;
		for (const [rel, ids] of idSets) {
			if (rel === c.file) continue;
			if (ids.has(c.name)) {
				referenced = true;
				break;
			}
		}
		if (!referenced) dead.push({ file: c.file, name: c.name, line: c.line, kind: c.kind });
	}
	return { total: candidates.length, entrypointExempt, substrateExempt, dead };
}

/** Print a human report when run directly: `bun scripts/dead-exports.ts [--files]` */
if (import.meta.main) {
	const showFiles = process.argv.includes("--files");
	const { total, entrypointExempt, substrateExempt, dead } = scan();
	console.log("\nDead-export inventory (src/, reference universe src/+webapp/)\n" + "=".repeat(60));
	console.log(`${total} exported function/const-arrow-fn candidates`);
	console.log(`${entrypointExempt} entrypoint-exempt (src/index.ts, src/*-main.ts)`);
	console.log(`${substrateExempt} @substrate-exempt`);
	const delta = dead.length - BASELINE;
	const flag = delta > 0 ? ` ⚠️ +${delta} OVER baseline` : delta < 0 ? ` ✓ ${-delta} below — tighten baseline to ${dead.length}` : " ✓ at baseline";
	console.log(`${dead.length} / ${BASELINE} baseline dead (no reference outside their own file)${flag}`);
	if (showFiles) for (const d of dead) console.log(`  ${d.file}:${d.line}  ${d.kind} ${d.name}`);
	else console.log("(pass --files to list every dead export)");
	console.log("\n" + "=".repeat(60));
	console.log(delta > 0 ? "OVER baseline — ratchet broken." : "At or below baseline.");
	process.exit(delta > 0 ? 1 : 0);
}
