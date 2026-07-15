/**
 * skills-verify — a truth gate for `.claude/skills/**`, the same discipline this repo already
 * applies to code (`defect-ratchet.ts`, `effect-migration.ts`) applied to the agent-facing docs
 * layer. A skill doc that says "run `bun run check`" or "`src/plane.ts` does X" or references a
 * `` `OMP_SQUAD_*` `` env var is a CLAIM about the codebase; nothing previously verified any of it.
 * This gate does, in five tiers:
 *
 *  1. TYPECHECK — every fenced ```ts/```typescript block in each skill's SKILL.md and its
 *     references/*.md files
 *     is extracted, synthesized into real `.ts` files under repo-root `.skills-verify/` (wiped and
 *     rewritten every run), and typechecked in-process against the ACTUALLY RESOLVED `effect` pin
 *     (read from `node_modules/effect/package.json`, cross-checked against `bun.lock`). No shelling
 *     out to `tsc` — `ts.createProgram` with explicit `rootNames`, never tsconfig include globs
 *     (a dot-dir include glob matches nothing; this was reproduced before this gate existed).
 *  2. WORKFLOW FILES — every `references/*.workflow.js` parses as valid JS (syntactic diagnostics
 *     only, not full typecheck — these are untyped `.js` on purpose).
 *  3. IDENTIFIER EXISTENCE — over every skill's prose (outside fences, plus inside ```bash fences):
 *     backticked `OMP_SQUAD_*`/`GLANCE_*` tokens must have a real env-read site in `src/**`;
 *     backticked repo-relative paths must exist on disk (skill-dir-relative, then repo-root);
 *     backticked `` `bun run <script>` `` must name a real package.json script.
 *  4. STRUCTURE — every skill (a directory containing `SKILL.md`) has `name`+`description`
 *     frontmatter, every markdown link resolves, every file in the skill dir is under its size cap.
 *  5. FRESHNESS — a `verified-against: <pkg>@<version>` frontmatter stamp must match the currently
 *     resolved version; `--stamp` is the only way to green a stale one (see the CLI section below).
 *
 * Escape hatches are accounted for, not silently trusted: a `no-verify reason="..."` block requires
 * a non-empty reason and is counted per-skill against a committed ratchet baseline (this file, below)
 * — same mechanism as `defect-ratchet.ts`'s `PATTERNS[].baseline`, same reason (opting out should be
 * monotonically expensive, not free). An untagged fence in a file that ALSO has a ts block hard-fails
 * (closes the "retag the broken example as prose" dodge). Identifier-tier false positives go in a
 * committed, size-ratcheted allowlist, never a silent skip.
 *
 * `tests/skills-verify.test.ts` imports `runSkillsVerify` and IS the entry point — nothing else
 * invokes this script under `bun test`; importing it also typechecks/loads it. Mirrors
 * `tests/defect-ratchet.test.ts`'s relationship to `defect-ratchet.ts`.
 *
 * Reach: this gates the REPO's own `.claude/skills/**` only. `--roots <comma,separated,paths>` runs
 * the same five tiers over any other directory (e.g. `~/.claude/skills`) in ADVISORY mode — findings
 * are still computed and printed, but the repo-manifest set-equality check and the `effect`-skill
 * tripwire (both repo-specific invariants) are skipped, and a violation there never fails `bun test`
 * (nothing in this repo's suite scans anything but the default root). The user-global skills pipeline
 * is real, higher-traffic, and explicitly OUT of this gate's authority — see `.claude/skills/README.md`.
 */
import ts from "typescript";
import { Glob } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_ROOT = join(REPO_ROOT, ".claude/skills");
const SYNTH_DIR = join(REPO_ROOT, ".skills-verify");

// ---------------------------------------------------------------------------------------------
// Committed manifest — the set of skill names this repo's gate is authoritative over. Compared by
// SET EQUALITY (not a count floor — a scan-count floor let `skillsScanned >= 9` count the README as
// a 9th skill; see plans/skills-hardening/DESIGN.md). A drifted set (a skill added/removed without
// updating this list) fails with a readable diff rather than silently passing or silently failing
// closed on a rename. Deliberately does NOT include "effect" yet — concern 02 vendors that skill;
// the `effectSkillHasVerifiedBlock` tripwire below is a no-op until it lands, by design.
// ---------------------------------------------------------------------------------------------
export const COMMITTED_SKILL_NAMES: readonly string[] = [
	"blind-review",
	"bounce",
	"effect",
	"execute-plan",
	"fleet-ide-loop",
	"land-sweep",
	"make-it-work",
	"reality-audit",
	"scratch-daemon",
].sort();

// Size caps over ALL files in a skill dir (not just SKILL.md). Measured against reality by 02's
// vendored `effect` skill (the largest corpus in the tree): SKILL.md tops out at ~7.6KB (48%
// headroom under the SKILL.md cap), and the largest reference doc (SERVICES_LAYERS.md) is ~8.9KB.
// The size lint walks every file in the skill dir, not just markdown — that includes the
// committed `vendor.patch` (a pristine→edited unified diff, ~27KB, the actual largest file in any
// skill dir today: a diff of ~30KB of adapted prose/code is naturally denser than any single
// source file it's diffing). SKILL_FILE_MAX_BYTES raised from the original provisional 24KB to
// 32KB to give that real file ~15% headroom rather than sitting right at the ceiling; SKILL.md's
// cap is untouched since nothing in that class has come close to it (see DESIGN.md's "Size lint"
// row, which sanctions setting these from vendor-time measurement).
export const SKILL_MD_MAX_BYTES = 16 * 1024;
export const SKILL_FILE_MAX_BYTES = 32 * 1024;

// Per-skill `no-verify reason="..."` ceiling — ratcheted like `defect-ratchet.ts`'s PATTERNS[].
// A skill that starts opting blocks out of verification must raise its own entry here in the
// same PR. "effect" carries 2: TESTING.md's two `it.effect(...)` examples come from
// `@effect/vitest`, which this repo does not depend on (this repo's test runner is `bun:test`) —
// see .claude/skills/effect/PROVENANCE.md item 9.
export const NO_VERIFY_BASELINE: Record<string, number> = {
	effect: 2,
};

// Identifier-tier false positives — committed, and the array's size is itself ratcheted (below)
// so growing the allowlist is a deliberate, reviewed act, not a silent skip. Each entry names the
// EXACT backticked token and why it isn't a real path.
export const IDENTIFIER_ALLOWLIST: readonly string[] = [
	// Build artifact — only exists after `cd webapp && bun run build`; referenced correctly in
	// bounce/SKILL.md, make-it-work/SKILL.md, scratch-daemon/SKILL.md as "the thing the daemon
	// serves once built", not a claim that it's committed.
	"webapp/dist",
	// Git branch names in execute-plan's stacked-plan worked example ("feat/A" from main,
	// "feat/B" from A) — illustrative, never meant to exist on disk.
	"feat/A",
	"feat/B",
	// Historical branch names from the land-sweep wrong-base-merge incident (PRs #27/#34/#35) —
	// long since deleted; named as evidence, not as a path to check out.
	"docs/full-overhaul",
	"feat/lifecycle-truth",
	"feat/never-lose-work",
	// npm/module import specifiers named in the vendored effect skill's prose (SKILL.md, CACHING.md,
	// HTTP_CLIENTS.md) — they contain "/" and look path-shaped to the identifier-tier regex, but
	// they name a package subpath (resolved through node_modules), not a repo-relative file.
	"effect/Cache",
	"effect/unstable/http/HttpClient",
	"effect/unstable/http/HttpClientRequest",
	"effect/unstable/http/HttpClientResponse",
	"effect/unstable/http/HttpClientError",
];
export const IDENTIFIER_ALLOWLIST_BASELINE = 11;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

interface FenceBlock {
	skill: string;
	skillDir: string;
	docRelPath: string; // relative to skill dir, e.g. "SKILL.md" or "references/foo.md"
	docAbsPath: string;
	lang: string; // lowercased first token of the info string; "" if untagged
	line: number; // 1-indexed line of the opening fence
	flags: Set<string>;
	attrs: Record<string, string>;
	body: string;
}

interface Violation {
	skill: string;
	file?: string;
	line?: number;
	message: string;
}

interface TsErrorEntry {
	skill: string;
	doc: string;
	blockId: string;
	file: string;
	message: string;
	line?: number;
}

export interface SkillsVerifyReport {
	ok: boolean;
	/** True only when scanning exactly this repo's own `.claude/skills` (the default). */
	gating: boolean;
	roots: string[];
	resolvedEffectVersion: string;
	skillsScanned: string[];
	manifestDrift: { missing: string[]; unexpected: string[] };
	frontmatterViolations: Violation[];
	structureViolations: Violation[];
	sizeViolations: Violation[];
	fenceViolations: Violation[];
	tsBlocksVerified: number;
	tsErrors: TsErrorEntry[];
	workflowFilesChecked: number;
	workflowErrors: Violation[];
	identifierViolations: Violation[];
	allowlistSize: number;
	allowlistBaseline: number;
	noVerify: Record<string, { count: number; baseline: number; reasons: string[] }>;
	noVerifyViolations: Violation[];
	verifiedAgainstViolations: Violation[];
	/** null = "effect" is not (yet) in the manifest, so the tripwire doesn't apply. */
	effectSkillHasVerifiedBlock: boolean | null;
	/** True iff the ONLY thing keeping `ok` false is a stale `verified-against` stamp — the state
	 *  `--stamp` exists to fix. See the CLI section for why this must be separate from `ok`. */
	readyToStamp: boolean;
}

// ---------------------------------------------------------------------------------------------
// Resolved-version guard
// ---------------------------------------------------------------------------------------------

/** Read the ACTUALLY resolved `effect` version from both node_modules and the lockfile, and
 *  hard-fail (throw) if either is missing or they disagree — a fresh worktree has a lockfile but
 *  no node_modules, and a stale node_modules can silently disagree with a bumped lockfile. Both
 *  are checked because either alone is trust-the-wrong-boundary: the type-checker resolves
 *  `effect` imports through node_modules, but a `bun install` mid-review could leave node_modules
 *  ahead of a not-yet-committed lockfile bump. Throws, never returns a guessed value — see this
 *  file's module doc and plans/skills-hardening/01-skills-verify-gate.md's Fail-closed section. */
export function resolveEffectVersion(): string {
	const pkgPath = join(REPO_ROOT, "node_modules/effect/package.json");
	const lockPath = join(REPO_ROOT, "bun.lock");
	if (!existsSync(pkgPath) || !existsSync(lockPath)) {
		throw new Error(
			"skills-verify: node_modules absent/stale — run `bun install`.\n" +
				`  expected both ${relative(REPO_ROOT, pkgPath)} and ${relative(REPO_ROOT, lockPath)} to exist.`,
		);
	}
	let nodeModulesVersion: string;
	try {
		nodeModulesVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
	} catch (e) {
		throw new Error(`skills-verify: node_modules absent/stale — ${pkgPath} is not valid JSON (${(e as Error).message}). Run \`bun install\`.`);
	}
	const lockText = readFileSync(lockPath, "utf8");
	const lockMatch = /"effect":\s*\[\s*"effect@([^"]+)"/.exec(lockText);
	if (!nodeModulesVersion || !lockMatch) {
		throw new Error(
			"skills-verify: node_modules absent/stale — could not read the `effect` version from " +
				`${nodeModulesVersion ? "bun.lock" : "node_modules/effect/package.json"}. Run \`bun install\`.`,
		);
	}
	const lockVersion = lockMatch[1];
	if (nodeModulesVersion !== lockVersion) {
		throw new Error(
			"skills-verify: node_modules absent/stale — resolved effect version disagrees between " +
				`node_modules (${nodeModulesVersion}) and bun.lock (${lockVersion}). Run \`bun install\`.`,
		);
	}
	return nodeModulesVersion;
}

// ---------------------------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------------------------

interface DiscoveredSkill {
	name: string;
	dir: string;
	root: string;
}

function discoverSkills(root: string): DiscoveredSkill[] {
	if (!existsSync(root)) return [];
	const out: DiscoveredSkill[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		if (existsSync(join(dir, "SKILL.md"))) out.push({ name: entry.name, dir, root });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

// ---------------------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------------------

interface Frontmatter {
	attrs: Record<string, string>;
	bodyStart: number; // char offset where the body begins (for line-number math)
}

function parseFrontmatter(text: string): Frontmatter | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return null;
	const attrs: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		if (!line.trim()) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		attrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { attrs, bodyStart: m[0].length };
}

// ---------------------------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------------------------

interface FenceSpan {
	lang: string;
	flags: Set<string>;
	attrs: Record<string, string>;
	line: number;
	bodyStartLine: number;
	body: string;
}

function parseInfoString(info: string): { lang: string; flags: Set<string>; attrs: Record<string, string> } {
	const trimmed = info.trim();
	if (!trimmed) return { lang: "", flags: new Set(), attrs: {} };
	const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const lang = (tokens[0] ?? "").toLowerCase();
	const flags = new Set<string>();
	const attrs: Record<string, string> = {};
	for (const tok of tokens.slice(1)) {
		const eq = tok.indexOf("=");
		if (eq === -1) {
			flags.add(tok);
			continue;
		}
		const key = tok.slice(0, eq);
		let value = tok.slice(eq + 1);
		if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		attrs[key] = value;
	}
	return { lang, flags, attrs };
}

/** Parse top-level ``` fences out of a markdown doc. Only top-level (column-0) fences are
 *  recognized — this repo's skill docs never nest fences, and scoping to top-level dodges the
 *  "fence inside a fence" ambiguity entirely rather than guessing at nesting rules. */
function extractFences(text: string): FenceSpan[] {
	const lines = text.split("\n");
	const spans: FenceSpan[] = [];
	let i = 0;
	while (i < lines.length) {
		const openMatch = /^```(.*)$/.exec(lines[i]);
		if (!openMatch) {
			i++;
			continue;
		}
		const { lang, flags, attrs } = parseInfoString(openMatch[1]);
		const bodyStartLine = i + 2; // 1-indexed line of the first body line
		const bodyLines: string[] = [];
		let j = i + 1;
		let closed = false;
		for (; j < lines.length; j++) {
			if (/^```\s*$/.test(lines[j])) {
				closed = true;
				break;
			}
			bodyLines.push(lines[j]);
		}
		spans.push({ lang, flags, attrs, line: i + 1, bodyStartLine, body: bodyLines.join("\n") });
		i = closed ? j + 1 : lines.length; // unterminated fence: stop (extremely malformed doc)
	}
	return spans;
}

/** Text with every fenced code block's body blanked out (newline-preserved, so line numbers in
 *  later regex scans over the result still line up with the original file). Used for markdown-link
 *  scanning, which should never fire on a code sample that happens to contain `(parens)`. */
function withAllFencesBlanked(text: string, spans: FenceSpan[]): string {
	const lines = text.split("\n");
	for (const span of spans) {
		for (let ln = span.bodyStartLine; ln < span.bodyStartLine + span.body.split("\n").length; ln++) {
			if (span.body === "") continue; // zero-line body, nothing to blank
			lines[ln - 1] = "";
		}
	}
	return lines.join("\n");
}

/** Text scannable by the identifier-existence tier: prose outside any fence, PLUS the body of any
 *  ```bash fence (bash examples make real claims — env vars, paths, `bun run` — same as prose).
 *  Every other fence's body (ts, json, whatever) is blanked; that content is either typechecked
 *  separately or out of scope. */
function scannableForIdentifiers(text: string, spans: FenceSpan[]): string {
	const lines = text.split("\n");
	for (const span of spans) {
		if (span.lang === "bash" || span.lang === "sh") continue;
		const bodyLineCount = span.body === "" ? 0 : span.body.split("\n").length;
		for (let ln = span.bodyStartLine; ln < span.bodyStartLine + bodyLineCount; ln++) lines[ln - 1] = "";
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Identifier-existence tier
// ---------------------------------------------------------------------------------------------

const ENV_TOKEN_RE = /^(?:OMP_SQUAD|GLANCE)_[A-Z0-9_]+$/;
// No leading '/', '~', '$', '<' (slash-commands, home paths, shell vars, placeholders are excluded
// structurally, not by allowlist); no glob/quote/brace/pipe chars; at least one '/'.
const REPO_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/;
const BUN_RUN_RE = /^bun run ([A-Za-z0-9:_-]+)$/;
const BACKTICK_RE = /`([^`\n]+)`/g;

let srcCorpusCache: string | null = null;
function readSrcCorpus(): string {
	if (srcCorpusCache !== null) return srcCorpusCache;
	const files = [...new Glob("src/**/*.ts").scanSync(REPO_ROOT)];
	srcCorpusCache = files.map((f) => readFileSync(join(REPO_ROOT, f), "utf8")).join("\n");
	return srcCorpusCache;
}

function envTokenHasReadSite(token: string): boolean {
	const corpus = readSrcCorpus();
	if (corpus.includes(`process.env.${token}`)) return true;
	if (corpus.includes(`"${token}"`) || corpus.includes(`'${token}'`) || corpus.includes(`\`${token}\``)) return true;
	return false;
}

function collectPackageScripts(): Set<string> {
	const names = new Set<string>();
	for (const p of [join(REPO_ROOT, "package.json"), join(REPO_ROOT, "webapp/package.json")]) {
		if (!existsSync(p)) continue;
		const pkg = JSON.parse(readFileSync(p, "utf8"));
		for (const k of Object.keys(pkg.scripts ?? {})) names.add(k);
	}
	return names;
}

function lineAt(text: string, charIndex: number): number {
	let line = 1;
	for (let i = 0; i < charIndex && i < text.length; i++) if (text[i] === "\n") line++;
	return line;
}

function checkIdentifiers(skill: DiscoveredSkill, docRelPath: string, docText: string, spans: FenceSpan[], scripts: Set<string>): Violation[] {
	const violations: Violation[] = [];
	const scannable = scannableForIdentifiers(docText, spans);
	for (const m of scannable.matchAll(BACKTICK_RE)) {
		const token = m[1];
		const line = lineAt(scannable, m.index ?? 0);
		if (ENV_TOKEN_RE.test(token)) {
			if (!envTokenHasReadSite(token)) {
				violations.push({
					skill: skill.name,
					file: docRelPath,
					line,
					message: `backticked env token \`${token}\` has no matching env-read site in src/**`,
				});
			}
			continue;
		}
		const bunRunMatch = BUN_RUN_RE.exec(token);
		if (bunRunMatch) {
			const script = bunRunMatch[1];
			if (!scripts.has(script)) {
				violations.push({
					skill: skill.name,
					file: docRelPath,
					line,
					message: `\`bun run ${script}\` names no script in package.json or webapp/package.json`,
				});
			}
			continue;
		}
		if (!token.includes("/")) continue;
		if (token.startsWith("http://") || token.startsWith("https://") || token.startsWith("~") || token.startsWith("$") || token.includes("<")) continue;
		if (!REPO_PATH_RE.test(token)) continue;
		if (token.startsWith("origin/")) continue; // git remote-tracking ref, not a repo path
		if (IDENTIFIER_ALLOWLIST.includes(token)) continue;
		const skillRelative = join(skill.dir, token);
		const repoRelative = join(REPO_ROOT, token);
		if (existsSync(skillRelative) || existsSync(repoRelative)) continue;
		violations.push({
			skill: skill.name,
			file: docRelPath,
			line,
			message: `backticked path \`${token}\` does not exist (checked ${relative(REPO_ROOT, skillRelative)} and ${token})`,
		});
	}
	return violations;
}

// ---------------------------------------------------------------------------------------------
// Structure: markdown links + size caps
// ---------------------------------------------------------------------------------------------

function checkMarkdownLinks(skill: DiscoveredSkill, docRelPath: string, docText: string, spans: FenceSpan[]): Violation[] {
	const violations: Violation[] = [];
	const scannable = withAllFencesBlanked(docText, spans);
	const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
	for (const m of scannable.matchAll(linkRe)) {
		let target = m[1].trim();
		if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#") || target.startsWith("mailto:")) continue;
		const hashIdx = target.indexOf("#");
		if (hashIdx !== -1) target = target.slice(0, hashIdx);
		if (!target) continue;
		const line = lineAt(scannable, m.index ?? 0);
		const skillRelative = join(skill.dir, target);
		const repoRelative = join(REPO_ROOT, target);
		if (existsSync(skillRelative) || existsSync(repoRelative)) continue;
		violations.push({ skill: skill.name, file: docRelPath, line, message: `relative link target \`${target}\` does not resolve` });
	}
	return violations;
}

function walkSkillFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkSkillFiles(p));
		else out.push(p);
	}
	return out;
}

function checkSizeCaps(skill: DiscoveredSkill): Violation[] {
	const violations: Violation[] = [];
	for (const abs of walkSkillFiles(skill.dir)) {
		const rel = relative(skill.dir, abs);
		const bytes = statSync(abs).size;
		const cap = rel === "SKILL.md" ? SKILL_MD_MAX_BYTES : SKILL_FILE_MAX_BYTES;
		if (bytes > cap) {
			violations.push({ skill: skill.name, file: rel, message: `${bytes} bytes exceeds the ${cap}-byte cap for this file` });
		}
	}
	return violations;
}

// ---------------------------------------------------------------------------------------------
// Workflow-file syntax check
// ---------------------------------------------------------------------------------------------

function checkWorkflowFiles(skills: DiscoveredSkill[]): { checked: number; errors: Violation[] } {
	const files: { skill: string; abs: string; rel: string }[] = [];
	for (const skill of skills) {
		const refDir = join(skill.dir, "references");
		if (!existsSync(refDir)) continue;
		for (const entry of readdirSync(refDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".workflow.js")) {
				files.push({ skill: skill.name, abs: join(refDir, entry.name), rel: `references/${entry.name}` });
			}
		}
	}
	if (files.length === 0) return { checked: 0, errors: [] };
	const program = ts.createProgram({
		rootNames: files.map((f) => f.abs),
		options: { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
	});
	const errors: Violation[] = [];
	for (const f of files) {
		const source = program.getSourceFile(f.abs);
		if (!source) {
			errors.push({ skill: f.skill, file: f.rel, message: "workflow file could not be parsed (no source file produced)" });
			continue;
		}
		for (const diag of program.getSyntacticDiagnostics(source)) {
			const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
			const line = diag.start !== undefined ? source.getLineAndCharacterOfPosition(diag.start).line + 1 : undefined;
			errors.push({ skill: f.skill, file: f.rel, line, message: msg });
		}
	}
	return { checked: files.length, errors };
}

// ---------------------------------------------------------------------------------------------
// TS block synthesis + in-process typecheck
// ---------------------------------------------------------------------------------------------

function docSlug(docRelPath: string): string {
	return docRelPath.replace(/\.md$/, "").replace(/[/\\]/g, "__");
}

interface SynthEntry {
	block: FenceBlock;
	absPath: string;
}

function synthesizeAndTypecheck(blocks: FenceBlock[], fenceViolations: Violation[]): { verified: number; errors: TsErrorEntry[] } {
	if (blocks.length === 0) return { verified: 0, errors: [] };

	// Group by (skill, doc) so blocks sharing a reference doc land in the same directory and can
	// import each other by relative specifier.
	const groups = new Map<string, FenceBlock[]>();
	for (const b of blocks) {
		const key = `${b.skill} ${b.docRelPath}`;
		const arr = groups.get(key) ?? [];
		arr.push(b);
		groups.set(key, arr);
	}

	const entries: SynthEntry[] = [];
	const seenFilenames = new Map<string, FenceBlock>(); // per-group collision detection
	for (const [key, groupBlocks] of groups) {
		const [skill, docRelPath] = key.split(" ");
		const groupDir = join(SYNTH_DIR, skill, docSlug(docRelPath));
		const localSeen = new Map<string, FenceBlock>();
		for (const block of groupBlocks) {
			let filename = block.attrs.file?.trim();
			if (filename) {
				if (filename.startsWith("/") || filename.includes("..") || isAbsolute(filename)) {
					fenceViolations.push({
						skill,
						file: docRelPath,
						line: block.line,
						message: `block id=${block.attrs.id} has an unsafe file= path: ${filename}`,
					});
					continue;
				}
				filename = filename.replace(/\.js$/, ".ts");
			} else {
				filename = `${block.attrs.id}.ts`;
			}
			const collision = localSeen.get(filename);
			if (collision) {
				fenceViolations.push({
					skill,
					file: docRelPath,
					line: block.line,
					message: `blocks id=${collision.attrs.id} and id=${block.attrs.id} both synthesize to ${filename} — give one a distinct file=`,
				});
				continue;
			}
			localSeen.set(filename, block);
			entries.push({ block, absPath: join(groupDir, filename) });
		}
		for (const [f, b] of localSeen) seenFilenames.set(`${skill}/${docRelPath}/${f}`, b);
	}

	if (entries.length === 0) return { verified: 0, errors: [] };

	rmSync(SYNTH_DIR, { recursive: true, force: true });
	for (const e of entries) {
		mkdirSync(dirname(e.absPath), { recursive: true });
		writeFileSync(e.absPath, e.block.body);
	}

	const configPath = join(REPO_ROOT, "tsconfig.json");
	const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic: (d) => {
			throw new Error(`skills-verify: could not parse tsconfig.json: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
		},
	});
	if (!parsed) throw new Error("skills-verify: ts.getParsedCommandLineOfConfigFile returned no result for the root tsconfig.json");

	const rootNames = entries.map((e) => e.absPath);
	const program = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true } });

	// Fail-closed: a program that silently dropped or deduped a synthesized file would let a real
	// type error go unreported. Never trust the diagnostics without this check first.
	const actualRootNames = program.getRootFileNames();
	if (actualRootNames.length !== entries.length) {
		throw new Error(
			`skills-verify: createProgram loaded ${actualRootNames.length} root files but ${entries.length} were synthesized — ` +
				"the typecheck below would be a vacuous pass. This is a bug in skills-verify, not the skill docs.",
		);
	}

	const byPath = new Map(entries.map((e) => [e.absPath, e.block] as const));
	const errors: TsErrorEntry[] = [];
	for (const diag of ts.getPreEmitDiagnostics(program)) {
		if (diag.category !== ts.DiagnosticCategory.Error) continue;
		if (!diag.file) continue;
		const block = byPath.get(diag.file.fileName);
		if (!block) continue; // diagnostic in a lib/node_modules file the program pulled in transitively
		const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
		const line = diag.start !== undefined ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1 : undefined;
		errors.push({ skill: block.skill, doc: block.docRelPath, blockId: block.attrs.id ?? "?", file: relative(REPO_ROOT, diag.file.fileName), message: msg, line });
	}

	return { verified: entries.length, errors };
}

// ---------------------------------------------------------------------------------------------
// verified-against stamping
// ---------------------------------------------------------------------------------------------

/** Rewrite every skill's `verified-against: <pkg>@<version>` frontmatter field to
 *  `<pkg>@<resolvedVersion>` (only for pkg === "effect", the only package this concern resolves).
 *  Only ever called by the CLI, and only after confirming the run is `readyToStamp` — see the
 *  module doc and `runSkillsVerify`'s `readyToStamp` field for why stamping can't require a fully
 *  green report (a stale stamp IS the thing making the report red). */
export function stampVerifiedAgainst(roots: string[] | undefined, resolvedEffectVersion: string): { skill: string; pkg: string; from: string; to: string }[] {
	const effectiveRoots = roots ?? [DEFAULT_ROOT];
	const changed: { skill: string; pkg: string; from: string; to: string }[] = [];
	for (const root of effectiveRoots) {
		for (const skill of discoverSkills(root)) {
			const skillMdPath = join(skill.dir, "SKILL.md");
			const content = readFileSync(skillMdPath, "utf8");
			const fm = parseFrontmatter(content);
			const declared = fm?.attrs["verified-against"];
			if (!declared) continue;
			const at = declared.lastIndexOf("@");
			if (at === -1) continue;
			const pkg = declared.slice(0, at);
			const version = declared.slice(at + 1);
			if (pkg !== "effect" || version === resolvedEffectVersion) continue;
			const rewritten = content.replace(/^(verified-against:\s*)\S+$/m, `$1${pkg}@${resolvedEffectVersion}`);
			writeFileSync(skillMdPath, rewritten);
			changed.push({ skill: skill.name, pkg, from: version, to: resolvedEffectVersion });
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------

export function runSkillsVerify(roots?: string[]): SkillsVerifyReport {
	const gating = roots === undefined;
	const effectiveRoots = roots ?? [DEFAULT_ROOT];
	const resolvedEffectVersion = resolveEffectVersion();

	const allSkills: DiscoveredSkill[] = [];
	for (const root of effectiveRoots) allSkills.push(...discoverSkills(root));

	if (allSkills.length === 0) {
		throw new Error(
			`skills-verify: zero skills found under [${effectiveRoots.join(", ")}] — ` +
				"a report claiming success over an empty scan is a vacuous pass, not a green gate. Check the --roots path.",
		);
	}

	const scannedNames = allSkills.map((s) => s.name).sort();

	const manifestDrift = { missing: [] as string[], unexpected: [] as string[] };
	if (gating) {
		const scannedSet = new Set(scannedNames);
		const committedSet = new Set(COMMITTED_SKILL_NAMES);
		for (const name of COMMITTED_SKILL_NAMES) if (!scannedSet.has(name)) manifestDrift.missing.push(name);
		for (const name of scannedNames) if (!committedSet.has(name)) manifestDrift.unexpected.push(name);
	}

	const frontmatterViolations: Violation[] = [];
	const structureViolations: Violation[] = [];
	const sizeViolations: Violation[] = [];
	const fenceViolations: Violation[] = [];
	const identifierViolations: Violation[] = [];
	const verifiedAgainstViolations: Violation[] = [];
	const noVerify: Record<string, { count: number; baseline: number; reasons: string[] }> = {};
	const allTsBlocks: FenceBlock[] = [];
	const scripts = collectPackageScripts();

	for (const skill of allSkills) {
		const skillMdPath = join(skill.dir, "SKILL.md");
		const skillMdText = readFileSync(skillMdPath, "utf8");
		const fm = parseFrontmatter(skillMdText);
		if (!fm) {
			frontmatterViolations.push({ skill: skill.name, file: "SKILL.md", message: "missing --- frontmatter block" });
		} else {
			if (!fm.attrs.name?.trim()) frontmatterViolations.push({ skill: skill.name, file: "SKILL.md", message: "frontmatter missing non-empty `name`" });
			if (!fm.attrs.description?.trim()) frontmatterViolations.push({ skill: skill.name, file: "SKILL.md", message: "frontmatter missing non-empty `description`" });
			const declared = fm.attrs["verified-against"];
			if (declared) {
				const at = declared.lastIndexOf("@");
				const pkg = at === -1 ? declared : declared.slice(0, at);
				const version = at === -1 ? "" : declared.slice(at + 1);
				if (pkg === "effect" && version !== resolvedEffectVersion) {
					verifiedAgainstViolations.push({
						skill: skill.name,
						file: "SKILL.md",
						message: `verified-against: effect@${version} but the resolved version is effect@${resolvedEffectVersion} — run \`bun run scripts/skills-verify.ts --stamp\` after a green run`,
					});
				}
			}
		}

		sizeViolations.push(...checkSizeCaps(skill));

		const docs: { rel: string; abs: string }[] = [{ rel: "SKILL.md", abs: skillMdPath }];
		const refDir = join(skill.dir, "references");
		if (existsSync(refDir)) {
			for (const entry of readdirSync(refDir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".md")) docs.push({ rel: `references/${entry.name}`, abs: join(refDir, entry.name) });
			}
		}

		let skillNoVerifyCount = 0;
		const skillNoVerifyReasons: string[] = [];

		for (const doc of docs) {
			const text = doc.rel === "SKILL.md" ? skillMdText : readFileSync(doc.abs, "utf8");
			const spans = extractFences(text);
			const hasTsBlock = spans.some((s) => s.lang === "ts" || s.lang === "typescript");

			for (const span of spans) {
				const isTs = span.lang === "ts" || span.lang === "typescript";
				if (!isTs) {
					if (span.lang === "" && hasTsBlock) {
						fenceViolations.push({
							skill: skill.name,
							file: doc.rel,
							line: span.line,
							message: "untagged fence in a file that also contains a ts block — tag it or add no-verify reason=\"...\"",
						});
					}
					continue;
				}
				const noVerifyReason = span.flags.has("no-verify") ? span.attrs.reason?.trim() : undefined;
				if (span.flags.has("no-verify")) {
					if (!noVerifyReason) {
						fenceViolations.push({ skill: skill.name, file: doc.rel, line: span.line, message: 'no-verify requires a non-empty reason="..."' });
					} else {
						skillNoVerifyCount++;
						skillNoVerifyReasons.push(noVerifyReason);
					}
					continue;
				}
				if (!span.attrs.id) {
					fenceViolations.push({ skill: skill.name, file: doc.rel, line: span.line, message: "ts block missing required id= (or no-verify reason=\"...\")" });
					continue;
				}
				if (!/^[A-Za-z0-9_-]+$/.test(span.attrs.id)) {
					fenceViolations.push({ skill: skill.name, file: doc.rel, line: span.line, message: `id="${span.attrs.id}" must match [A-Za-z0-9_-]+` });
					continue;
				}
				allTsBlocks.push({ skill: skill.name, skillDir: skill.dir, docRelPath: doc.rel, docAbsPath: doc.abs, lang: span.lang, line: span.line, flags: span.flags, attrs: span.attrs, body: span.body });
			}

			structureViolations.push(...checkMarkdownLinks(skill, doc.rel, text, spans));
			identifierViolations.push(...checkIdentifiers(skill, doc.rel, text, spans, scripts));
		}

		noVerify[skill.name] = { count: skillNoVerifyCount, baseline: NO_VERIFY_BASELINE[skill.name] ?? 0, reasons: skillNoVerifyReasons };
	}

	const { verified: tsBlocksVerified, errors: tsErrors } = synthesizeAndTypecheck(allTsBlocks, fenceViolations);

	const { checked: workflowFilesChecked, errors: workflowErrors } = checkWorkflowFiles(allSkills);

	const noVerifyViolations: Violation[] = [];
	for (const [skill, entry] of Object.entries(noVerify)) {
		if (entry.count > entry.baseline) {
			noVerifyViolations.push({
				skill,
				message: `${entry.count} no-verify block(s), baseline is ${entry.baseline} (+${entry.count - entry.baseline}) — fix the block or raise NO_VERIFY_BASELINE["${skill}"] deliberately`,
			});
		}
	}

	let effectSkillHasVerifiedBlock: boolean | null = null;
	if (scannedNames.includes("effect")) {
		effectSkillHasVerifiedBlock = allTsBlocks.some((b) => b.skill === "effect" && !b.flags.has("no-verify")) && tsBlocksVerified > 0;
	}

	const nonVersionOk =
		manifestDrift.missing.length === 0 &&
		manifestDrift.unexpected.length === 0 &&
		frontmatterViolations.length === 0 &&
		structureViolations.length === 0 &&
		sizeViolations.length === 0 &&
		fenceViolations.length === 0 &&
		tsErrors.length === 0 &&
		workflowErrors.length === 0 &&
		identifierViolations.length === 0 &&
		noVerifyViolations.length === 0 &&
		IDENTIFIER_ALLOWLIST.length <= IDENTIFIER_ALLOWLIST_BASELINE &&
		effectSkillHasVerifiedBlock !== false;

	const ok = nonVersionOk && verifiedAgainstViolations.length === 0;
	const readyToStamp = nonVersionOk && verifiedAgainstViolations.length > 0;

	return {
		ok,
		gating,
		roots: effectiveRoots,
		resolvedEffectVersion,
		skillsScanned: scannedNames,
		manifestDrift,
		frontmatterViolations,
		structureViolations,
		sizeViolations,
		fenceViolations,
		tsBlocksVerified,
		tsErrors,
		workflowFilesChecked,
		workflowErrors,
		identifierViolations,
		allowlistSize: IDENTIFIER_ALLOWLIST.length,
		allowlistBaseline: IDENTIFIER_ALLOWLIST_BASELINE,
		noVerify,
		noVerifyViolations,
		verifiedAgainstViolations,
		effectSkillHasVerifiedBlock,
		readyToStamp,
	};
}

// ---------------------------------------------------------------------------------------------
// CLI: `bun scripts/skills-verify.ts [--stamp] [--roots a,b,c]`
// ---------------------------------------------------------------------------------------------

function printReport(report: SkillsVerifyReport): void {
	console.log("\nskills-verify" + (report.gating ? " (gating)" : " (advisory)") + "\n" + "=".repeat(48));
	console.log(`roots: ${report.roots.join(", ")}`);
	console.log(`resolved effect version: ${report.resolvedEffectVersion}`);
	console.log(`skills scanned: ${report.skillsScanned.join(", ")}`);
	if (report.manifestDrift.missing.length || report.manifestDrift.unexpected.length) {
		console.log(`manifest drift — missing: [${report.manifestDrift.missing.join(", ")}] unexpected: [${report.manifestDrift.unexpected.join(", ")}]`);
	}
	console.log(`ts blocks verified: ${report.tsBlocksVerified} (${report.tsErrors.length} error(s))`);
	console.log(`workflow files checked: ${report.workflowFilesChecked} (${report.workflowErrors.length} error(s))`);
	console.log(`identifier allowlist: ${report.allowlistSize}/${report.allowlistBaseline}`);
	for (const [skill, entry] of Object.entries(report.noVerify)) {
		if (entry.count > 0) console.log(`no-verify[${skill}]: ${entry.count}/${entry.baseline} — reasons: ${entry.reasons.join("; ")}`);
	}
	const allViolations = [
		...report.frontmatterViolations,
		...report.structureViolations,
		...report.sizeViolations,
		...report.fenceViolations,
		...report.identifierViolations,
		...report.noVerifyViolations,
		...report.verifiedAgainstViolations,
	];
	for (const v of allViolations) console.log(`  VIOLATION [${v.skill}]${v.file ? ` ${v.file}${v.line ? `:${v.line}` : ""}` : ""}: ${v.message}`);
	for (const e of report.tsErrors) console.log(`  TS ERROR [${e.skill}/${e.doc}#${e.blockId}]${e.line ? `:${e.line}` : ""}: ${e.message}`);
	for (const e of report.workflowErrors) console.log(`  WORKFLOW ERROR [${e.skill}] ${e.file}${e.line ? `:${e.line}` : ""}: ${e.message}`);
	if (report.effectSkillHasVerifiedBlock === false) console.log("  VIOLATION [effect]: skill is in the manifest but contributed 0 verified ts blocks");
	console.log("=".repeat(48));
	console.log(report.ok ? "skills-verify: green." : "skills-verify: RED — see violations above.");
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const stamp = argv.includes("--stamp");
	const rootsFlagIdx = argv.findIndex((a) => a === "--roots" || a.startsWith("--roots="));
	let roots: string[] | undefined;
	if (rootsFlagIdx !== -1) {
		const flag = argv[rootsFlagIdx];
		const value = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : argv[rootsFlagIdx + 1];
		roots = (value ?? "")
			.split(",")
			.map((s) => expandHome(s.trim()))
			.filter(Boolean);
	}

	const report = runSkillsVerify(roots);
	printReport(report);

	if (stamp) {
		if (!report.readyToStamp) {
			console.log(report.ok ? "\n--stamp: nothing to stamp (already green, no stale verified-against stamps)." : "\n--stamp: refused — the run isn't green apart from stamps; fix the other violations first.");
			process.exit(report.ok ? 0 : 1);
		}
		const changed = stampVerifiedAgainst(roots, report.resolvedEffectVersion);
		for (const c of changed) console.log(`stamped [${c.skill}]: ${c.pkg}@${c.from} -> ${c.pkg}@${c.to}`);
		console.log(changed.length ? `\n--stamp: rewrote ${changed.length} stamp(s).` : "\n--stamp: nothing to stamp.");
		process.exit(0);
	}

	process.exit(report.ok ? 0 : 1);
}
