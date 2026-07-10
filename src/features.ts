/**
 * Feature derivation (Phase 1 — read-only).
 *
 * A Feature is a cross-cutting unit of work. Phase 1 derives features purely from
 * existing state with NO new persistence:
 *   - one feature per `plans/<x>/` dir   (planned work, possibly with Plane issues)
 *   - one feature per roster agent       (in-flight work living in a git worktree)
 *
 * Land status (ahead/behind/diverged + unlanded file count) is computed live from
 * git so the board can surface the two states nothing else shows: "finished in a
 * worktree but NOT in main — Land to test" and "branch diverged, can't cleanly land".
 */

import { normalizeRepoPath } from "./project-registry.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hardenedGitSync } from "./git-harden.ts";
import { worktreeDiff } from "./explore.ts";
import { isFresh, proofFingerprint, proofFor } from "./proof.ts";
// Reuse the webapp diagram's PURE graph core (zero imports) so the daemon-side validator
// and the UI share ONE cycle/unresolved-dep algorithm — imported, never hand-copied.
import { buildPlanGraph } from "../webapp/src/lib/planGraph.ts";
import type { GraphConcernInput, PlanGraphIssue } from "../webapp/src/lib/planGraph.ts";
import type { AgentDTO, AgentStatus, FeatureContextSummary, FeatureCriterion, FeatureDecision, FeatureDTO, FeatureProofAggregate, FeatureReadiness, FeatureRelationship, FeatureStage, FeatureWorktreeStatus, LandReadiness, PersistedFeature, WorktreeProofSummary } from "./types.ts";

function git(cwd: string, args: string[]): string | undefined {
	try {
		const r = hardenedGitSync(["-C", cwd, ...args]);
		if (r.code !== 0) return undefined;
		return r.stdout.trim();
	} catch {
		return undefined;
	}
}

/** Commits on `branch` not in main (ahead) and on main not in `branch` (behind).
 *
 * Returns `{ ok: false }` on git error (bad ref, detached HEAD, I/O failure) so callers
 * can distinguish a real error from a genuine 0/0 (nothing ahead, nothing behind). Silently
 * returning `{ ahead: 0, behind: 0 }` on error masked "diverged" as "clean", which caused
 * the UI to show a branch as ready-to-land when git couldn't compute the real count.
 */
function aheadBehind(repo: string, branch: string): { ok: true; ahead: number; behind: number } | { ok: false; error: string } {
	const out = git(repo, ["rev-list", "--left-right", "--count", `HEAD...${branch}`]);
	if (out === undefined) return { ok: false, error: `git rev-list failed for branch ${JSON.stringify(branch)} in ${JSON.stringify(repo)}` };
	const parts = out.split(/\s+/).map((n) => Number.parseInt(n, 10));
	if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return { ok: false, error: `unexpected git output: ${JSON.stringify(out)}` };
	return { ok: true, behind: parts[0] ?? 0, ahead: parts[1] ?? 0 };
}

/** True if merging `branch` into main would conflict (git >= 2.38 merge-tree); undefined if unsupported. */
function predictsConflict(repo: string, branch: string): boolean | undefined {
	try {
		const r = hardenedGitSync(["-C", repo, "merge-tree", "--write-tree", "HEAD", branch]);
		if (r.code === 128) return undefined; // merge-tree unsupported / bad ref
		return r.code !== 0 || r.stdout.includes("CONFLICT");
	} catch {
		return undefined;
	}
}

export interface LandMember {
	agentId?: string;
	agentName?: string;
	branch?: string;
	worktree: string;
	repo: string;
}

/** Live land readiness for each member worktree vs. its repo's main. */
export async function featureLandStatus(members: LandMember[]): Promise<FeatureWorktreeStatus[]> {
	const out: FeatureWorktreeStatus[] = [];
	for (const m of members) {
		const changedFiles = await worktreeDiff(m.worktree)
			.then((d) => d.length)
			.catch(() => 0);
		let ahead = 0;
		let behind = 0;
		let readiness: LandReadiness;
		if (m.branch === undefined || path.resolve(m.worktree) === path.resolve(m.repo)) {
			readiness = "no-branch";
		} else {
			const ab = aheadBehind(m.repo, m.branch);
			if (!ab.ok) {
				// git failed (bad ref, detached HEAD, I/O failure) — surface as diverged so the
				// branch is never silently shown as clean / landing-ready when we couldn't compute
				// the real count. The operator will see it as "needs attention" rather than "done".
				readiness = "diverged";
			} else {
				ahead = ab.ahead;
				behind = ab.behind;
				if (behind > 0 && ahead > 0 && (predictsConflict(m.repo, m.branch) ?? true)) readiness = "diverged";
				else if (changedFiles > 0) readiness = "uncommitted";
				else if (ahead > 0) readiness = "ahead";
				else readiness = "clean";
			}
		}
		// ponytail: one proof-file read + one `git rev-parse HEAD` per member. featureLandStatus
		// already spawns git several times per member, so this marginal cost is acceptable.
		const proof = await proofFor(m.repo, m.worktree);
		let proofState: WorktreeProofSummary["state"] = "none";
		if (proof) proofState = !proof.ok ? "failed" : isFresh(proof, await proofFingerprint(m.repo, m.worktree, proof.command)) ? "fresh" : "stale";
		const proofSummary: WorktreeProofSummary = { state: proofState, ranAt: proof?.ranAt, artifacts: proof?.artifacts.length ?? 0 };
		out.push({ agentId: m.agentId, agentName: m.agentName, branch: m.branch, worktree: m.worktree, changedFiles, ahead, behind, readiness, proof: proofSummary });
	}
	return out;
}

const PLANE_RE = /\bPLANE:\s*([A-Z0-9]+-\d+)/g;
const PLAN_TITLE_FILES = ["00-overview.md", "overview.md", "README.md", "readme.md", "DESIGN.md"];
const GENERIC_PLAN_TITLES = new Set(["overview", "design", "research", "status", "goal", "summary", "plan"]);
const GENERIC_META_DESCRIPTION_RE = /^Stage:\s*.+\nRepo:\s*.+(?:\n(?:Plan|Issues|Agents|Workflow|Blocked|Diverged):\s*.*)*\s*$/i;



function humanPlanTitle(dir: string): string {
	return path.basename(dir).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function planTitleFromText(text: string, fallback: string): string {
	const title = C_TITLE.exec(text)?.[1]?.trim();
	return title && !GENERIC_PLAN_TITLES.has(title.toLowerCase()) ? title : fallback;
}


function weakPlanTitle(title: string, dir: string): boolean {
	const base = path.basename(dir);
	const norm = (value: string) => value.trim().toLowerCase();
	return new Set([base, humanPlanTitle(base), humanPlanTitle(dir)].map(norm)).has(norm(title));
}
function fileTimes(stat: { birthtimeMs: number; ctimeMs: number; mtimeMs: number }): { createdAt: number; updatedAt: number } {
	const createdAt = Math.round(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs);
	return { createdAt, updatedAt: Math.round(stat.mtimeMs) };
}

function persistedDescription(text: string | undefined): string | undefined {
	return text && !GENERIC_META_DESCRIPTION_RE.test(text.trim()) ? text : undefined;
}



export interface PlanDirInfo {
	/** Repo-relative dir, e.g. "plans/auth". */
	dir: string;
	title: string;
	issueIds: string[];
	createdAt: number;
	updatedAt: number;
}

/** Scan the repo's plans/ directory for plan dirs (each containing markdown), extracting any PLANE: pointers. */
export async function listPlanDirs(repo: string): Promise<PlanDirInfo[]> {
	const root = path.join(repo, "plans");
	let entries: string[];
	try {
		entries = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
	} catch {
		return [];
	}
	const out: PlanDirInfo[] = [];
	for (const name of entries.sort()) {
		const dirAbs = path.join(root, name);
		let files: string[];
		try {
			files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
		} catch {
			continue;
		}
		if (files.length === 0) continue;
		const times = fileTimes(await fs.stat(dirAbs));
		const issueIds = new Set<string>();
		for (const f of files) {
			const text = await fs.readFile(path.join(dirAbs, f), "utf8").catch(() => "");
			for (const m of text.matchAll(PLANE_RE)) issueIds.add(m[1]);
		}
		const titleFile = PLAN_TITLE_FILES.find((file) => files.includes(file)) ?? files[0];
		const titleText = titleFile ? await fs.readFile(path.join(dirAbs, titleFile), "utf8").catch(() => "") : "";
		out.push({ dir: path.join("plans", name), title: planTitleFromText(titleText, humanPlanTitle(name)), issueIds: [...issueIds], ...times });
	}
	return out;
}

// ── plan-dir lifecycle (archive / restore / delete) ──────────────────────────
//
// "Archive" is reversible: the plan dir is MOVED under `plans/.archive/<name>/`
// (which listPlanDirs skips, so it disappears from the board but the bytes stay).
// "Delete" is permanent: the dir is removed from wherever it lives. Both no-op
// gracefully when the source isn't present, so a double-archive / missing dir
// never throws and never blocks the feature-flag flip.

/** Repo-relative archive root for plan dirs. */
export const PLAN_ARCHIVE_DIR = path.join("plans", ".archive");

/** Resolve a plan dir's live and archived absolute paths. `planDir` is repo-relative ("plans/<name>"). */
function planDirLocations(repo: string, planDir: string): { name: string; live: string; archived: string } {
	const name = path.basename(planDir);
	return { name, live: path.join(repo, "plans", name), archived: path.join(repo, PLAN_ARCHIVE_DIR, name) };
}

async function pathExists(p: string): Promise<boolean> {
	try { await fs.stat(p); return true; } catch { return false; }
}

/** Move a plan dir into plans/.archive/ (reversible). Returns true if a move happened. */
export async function archivePlanDir(repo: string, planDir: string): Promise<boolean> {
	const { live, archived } = planDirLocations(repo, planDir);
	if (!(await pathExists(live)) || (await pathExists(archived))) return false; // already archived or nothing to move
	await fs.mkdir(path.dirname(archived), { recursive: true });
	await fs.rename(live, archived);
	return true;
}

/** Move a plan dir back out of plans/.archive/. Returns true if a move happened. */
export async function restorePlanDir(repo: string, planDir: string): Promise<boolean> {
	const { live, archived } = planDirLocations(repo, planDir);
	if (!(await pathExists(archived)) || (await pathExists(live))) return false; // already live or nothing to restore
	await fs.mkdir(path.dirname(live), { recursive: true });
	await fs.rename(archived, live);
	return true;
}

/** Permanently remove a plan dir from wherever it lives (live or archived). Returns true if anything was removed. */
export async function deletePlanDir(repo: string, planDir: string): Promise<boolean> {
	const { live, archived } = planDirLocations(repo, planDir);
	let removed = false;
	for (const target of [live, archived]) {
		if (await pathExists(target)) { await fs.rm(target, { recursive: true, force: true }); removed = true; }
	}
	return removed;
}

/** PLANE: pointer identifiers found across all markdown in one plan dir. */
async function planeIdsIn(dirAbs: string): Promise<string[]> {
	let files: string[];
	try {
		files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	const ids = new Set<string>();
	for (const f of files) {
		const text = await fs.readFile(path.join(dirAbs, f), "utf8").catch(() => "");
		for (const m of text.matchAll(PLANE_RE)) ids.add(m[1]);
	}
	return [...ids];
}

const PLANE_MODULE_RE = /https?:\/\/[^\s)\]]+\/modules\/[0-9a-fA-F-]{8,}\/?/;

/**
 * Plane module URL backfilled into a plan dir by /plan-to-plane (under "## Plane tracking").
 * Lets the webui show "Module linked" for plans filed via the MCP skill, whose module the daemon
 * never created itself (so `pf.plane.moduleUrl` is unset). Overview preferred; else any markdown.
 */
export async function planeModuleUrlIn(dirAbs: string): Promise<string | undefined> {
	const ov = await findOverviewFile(dirAbs);
	let files: string[];
	if (ov) files = [ov];
	else {
		try {
			files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
		} catch {
			return undefined;
		}
	}
	for (const f of files) {
		const text = await fs.readFile(path.join(dirAbs, f), "utf8").catch(() => "");
		const m = PLANE_MODULE_RE.exec(text);
		if (m) return m[0].replace(/\/$/, "");
	}
	return undefined;
}

/** One markdown doc inside a plan dir. */
export interface PlanDocument {
	file: string;
	path: string;
	title: string;
	content: string;
	concern: boolean;
	createdAt: number;
	updatedAt: number;
}

/** One concern doc inside a plan dir (a `plans/<x>/NN-*.md` with a STATUS frontmatter line). */
export interface PlanConcern {
	file: string;
	path: string;
	title: string;
	status: string;
	priority?: string;
	complexity?: string;
	planeId?: string;
	open: boolean;
	acceptanceCriteria: string[];
	prerequisites: string[];
	decisions: string[];
	touches: string[];
	content: string;
}

const C_STATUS = /^STATUS:\s*([\w-]+)/im;
const C_STATUS_BOLD = /^\*\*Status:\*\*\s*([\w-]+)/im;
const C_STATUS_H2 = /^##\s*Status:\s*(?:[^\w\s]+\s*)?([\w-]+)/im;
const C_PRIORITY = /^PRIORITY:\s*(p[0-3])/im;
const C_COMPLEXITY = /^COMPLEXITY:\s*([\w-]+)/im;
const C_PLANE_LINE = /^PLANE:\s*([A-Z0-9]+-\d+)/m;
const C_TITLE = /^#\s+(.+?)\s*$/m;
const CONCERN_SKIP = new Set(["00-overview.md", "overview.md", "design.md", "readme.md"]);
const CLOSED_STATUS = new Set(["closed", "done", "complete", "completed", "cancelled", "canceled"]);
const C_BLOCKED_BY = /^BLOCKED_BY:\s*(.+)$/im;


function markdownSectionItems(text: string, names: string[]): string[] {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let inSection = false;
	for (const line of lines) {
		const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			inSection = wanted.has(heading[2].replace(/[:#]+$/g, "").trim().toLowerCase());
			continue;
		}
		if (!inSection) continue;
		const bullet = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/.exec(line);
		if (bullet?.[1]) out.push(bullet[1].trim());
		else if (line.trim() && !line.startsWith("STATUS:") && !line.startsWith("PRIORITY:") && !line.startsWith("COMPLEXITY:")) out.push(line.trim());
	}
	return out;
}
function planTouches(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = /^TOUCHES:\s*(.*?)\s*$/i.exec(lines[i]);
		if (!match) continue;
		if (match[1]) out.push(...splitTouches(match[1]));
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			if (!line.trim()) break;
			if (/^(#{1,6}\s+|[A-Z_]+:)/.test(line)) break;
			const item = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
			if (item) out.push(...splitTouches(item));
		}
	}
	return [...new Set(out)];
}

function splitTouches(value: string): string[] {
	return value.split(",").map((item) => item.replace(/[`"'[\]]/g, "").trim()).filter(Boolean);
}

function planPrerequisites(text: string): string[] {
	const items = markdownSectionItems(text, ["Prerequisites", "Dependencies", "Blocked By", "Blockers"]);
	const blocked = C_BLOCKED_BY.exec(text)?.[1]?.trim();
	return blocked && blocked !== "—" && blocked !== "-" ? [`Blocked by ${blocked}`, ...items] : items;
}


/** Parse the concern docs in a plan dir (files carrying a STATUS line); skips overview/design docs. */
export async function parsePlanConcerns(repo: string, planDir: string): Promise<PlanConcern[]> {
	const dirAbs = path.join(repo, planDir);
	let files: string[];
	try {
		files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	const out: PlanConcern[] = [];
	for (const f of files.sort()) {
		if (CONCERN_SKIP.has(f.toLowerCase())) continue;
		const text = await fs.readFile(path.join(dirAbs, f), "utf8").catch(() => "");
		const sm = C_STATUS.exec(text) ?? C_STATUS_BOLD.exec(text) ?? C_STATUS_H2.exec(text);
		if (!sm) continue; // no STATUS ⇒ a doc, not a concern
		const status = sm[1].toLowerCase().replace(/_/g, "-");
		out.push({
			file: f,
			path: path.join(planDir, f),
			title: C_TITLE.exec(text)?.[1] ?? f.replace(/\.md$/, ""),
			status,
			priority: C_PRIORITY.exec(text)?.[1]?.toLowerCase(),
			complexity: C_COMPLEXITY.exec(text)?.[1]?.toLowerCase(),
			planeId: C_PLANE_LINE.exec(text)?.[1],
			open: !CLOSED_STATUS.has(status),
			acceptanceCriteria: markdownSectionItems(text, ["Acceptance Criteria", "Acceptance"]),
			prerequisites: planPrerequisites(text),
			decisions: markdownSectionItems(text, ["Decisions", "Decision Log", "Rationale"]),
			touches: planTouches(text),
			content: text,
		});
	}
	return out;
}

/** Read the raw text of a plan's overview doc (holds the "Dependency graph" table), or "". */
async function readPlanOverview(repo: string, planDir: string): Promise<string> {
	const dirAbs = path.join(repo, planDir);
	for (const name of PLAN_TITLE_FILES) {
		const text = await fs.readFile(path.join(dirAbs, name), "utf8").catch(() => null);
		if (text != null) return text;
	}
	return "";
}

/**
 * Validate a plan dir's dependency graph — dependency cycles + unresolved (dangling) deps —
 * using the SAME pure core the webapp diagram uses (buildPlanGraph). One algorithm, imported
 * not copied (concern 06 / red-team B-S4). Non-UI consumers (the pipeline skills) reach this
 * through `omp-squad plan-validate <dir>`.
 */
export async function validatePlanConcerns(repo: string, planDir: string): Promise<PlanGraphIssue[]> {
	const concerns = await parsePlanConcerns(repo, planDir);
	const overviewText = await readPlanOverview(repo, planDir);
	const inputs: GraphConcernInput[] = concerns.map((c) => ({
		file: c.file,
		title: c.title,
		status: c.status,
		open: c.open,
		complexity: c.complexity,
		prerequisites: c.prerequisites,
		touches: c.touches,
	}));
	return buildPlanGraph(inputs, overviewText).issues;
}

export async function parsePlanDocuments(repo: string, planDir: string): Promise<PlanDocument[]> {
	const dirAbs = path.join(repo, planDir);
	let files: string[];
	try {
		files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return Promise.all(files.sort().map(async (file): Promise<PlanDocument> => {
		const content = await fs.readFile(path.join(dirAbs, file), "utf8").catch(() => "");
		const times = fileTimes(await fs.stat(path.join(dirAbs, file)));
		const sm = C_STATUS.exec(content) ?? C_STATUS_BOLD.exec(content) ?? C_STATUS_H2.exec(content);
		return {
			file,
			path: path.join(planDir, file),
			title: C_TITLE.exec(content)?.[1] ?? file.replace(/\.md$/, ""),
			content,
			concern: !CONCERN_SKIP.has(file.toLowerCase()) && !!sm,
			...times,
		};
	}));
}

// ── concern editing (plan flow-diagram writes) ───────────────────────────────
//
// The webapp plan flow diagram (lib/planGraph + PlanFlowDiagram) lets an operator
// change a concern's STATUS and the concerns that block it, straight from a node.
// Those edits land HERE: we rewrite the concern doc's STATUS:/BLOCKED_BY: lines AND
// the 00-overview "Dependency graph" table row, keeping the two sources the diagram
// reads in sync. Pure string surgery (no fs) lives in the set*() helpers so they're
// unit-testable; updatePlanConcern() is the fs-touching orchestrator.

const C_STATUS_LINE = /^(STATUS:[ \t]*)([\w-]+)(.*)$/im;
const C_STATUS_BOLD_LINE = /^(\*\*Status:\*\*[ \t]*)([\w-]+)(.*)$/im;
const C_STATUS_H2_LINE = /^(##[ \t]*Status:[ \t]*(?:[^\w\s]+[ \t]*)?)([\w-]+)(.*)$/im;

/** True when a concern STATUS value means the work is finished (closed/done/…). */
export function isClosedConcernStatus(status: string): boolean {
	return CLOSED_STATUS.has(status.toLowerCase().replace(/_/g, "-"));
}

const PLAN_DOC_REF = /\bplans\/[\w.-]+(?:\/[\w.-]+)*\.md\b/g;

/** Plan-doc paths referenced in free text (issue names/bodies): `plans/<dir>/…/<file>.md`. */
export function planDocRefs(text: string): string[] {
	return [...new Set(text.match(PLAN_DOC_REF) ?? [])];
}

/**
 * STATUS value of one concern doc (any of the three notations), or null when the file
 * doesn't exist / carries no STATUS line. Reads the CHECKED-OUT tree — the same source
 * parsePlanConcerns uses — so it reflects what a land actually shipped.
 */
export async function concernDocStatus(repo: string, docPath: string): Promise<string | null> {
	// Never let a crafted path escape the repo (docPath comes from external issue text).
	const abs = path.resolve(repo, docPath);
	if (!abs.startsWith(path.resolve(repo) + path.sep)) return null;
	const text = await fs.readFile(abs, "utf8").catch(() => null);
	if (!text) return null;
	const sm = C_STATUS.exec(text) ?? C_STATUS_BOLD.exec(text) ?? C_STATUS_H2.exec(text);
	return sm ? sm[1].toLowerCase().replace(/_/g, "-") : null;
}

/** Leading concern number from a file like "03-runtime.md" → 3 (null if none). Mirrors webapp concernNum. */
export function concernNumFromFile(file: string): number | null {
	const m = /(?:^|\/)(\d{1,3})[-_.]/.exec(file) ?? /^(\d{1,3})\b/.exec(file);
	return m ? Number(m[1]) : null;
}

/** Format blocker concern numbers for a BLOCKED_BY: line or table cell (dedup + sort; empty → "none"). */
function formatBlockerList(nums: number[], joiner: (n: number) => string): string {
	const uniq = [...new Set(nums.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
	return uniq.length ? uniq.map(joiner).join(", ") : "none";
}

/** Set a concern doc's STATUS, preserving whichever of the three notations it uses; insert one if absent. */
export function setConcernStatus(text: string, status: string): string {
	const s = status.trim();
	if (!s) return text;
	for (const re of [C_STATUS_LINE, C_STATUS_BOLD_LINE, C_STATUS_H2_LINE]) {
		if (re.test(text)) return text.replace(re, (_m, p1: string, _old: string, p3: string) => `${p1}${s}${p3}`);
	}
	const titleM = /^#[ \t]+.+$/m.exec(text);
	if (titleM) {
		const at = titleM.index + titleM[0].length;
		return `${text.slice(0, at)}\n\nSTATUS: ${s}${text.slice(at)}`;
	}
	return `STATUS: ${s}\n${text}`;
}

/** Set a concern doc's BLOCKED_BY: line (after STATUS/title when absent). Numbers render as "concern #N". */
export function setConcernBlockedBy(text: string, nums: number[]): string {
	const value = formatBlockerList(nums, (n) => `concern #${n}`);
	if (C_BLOCKED_BY.test(text)) return text.replace(C_BLOCKED_BY, `BLOCKED_BY: ${value}`);
	const statusM = C_STATUS.exec(text) ?? C_STATUS_BOLD.exec(text) ?? C_STATUS_H2.exec(text) ?? /^#[ \t]+.+$/m.exec(text);
	if (statusM) {
		const lineEnd = text.indexOf("\n", statusM.index);
		const at = lineEnd < 0 ? text.length : lineEnd;
		return `${text.slice(0, at)}\nBLOCKED_BY: ${value}${text.slice(at)}`;
	}
	return `BLOCKED_BY: ${value}\n${text}`;
}

/**
 * Rewrite the BLOCKED_BY cell for `num`'s row in the overview "Dependency graph" table,
 * preserving every other column. Appends a row if `num` has none yet; returns the text
 * unchanged when the overview has no such table (the concern's own BLOCKED_BY then carries it).
 */
export function setOverviewDepRow(overviewText: string, num: number, nums: number[]): string {
	if (!overviewText) return overviewText;
	const eol = overviewText.includes("\r\n") ? "\r\n" : "\n";
	const lines = overviewText.split(/\r?\n/);
	const headingIdx = lines.findIndex((l) => /^#{1,6}\s*Dependency graph/i.test(l.trim()));
	if (headingIdx < 0) return overviewText;
	let start = -1;
	let end = -1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const t = lines[i].trim();
		if (/^#{1,6}\s/.test(t)) break; // next section
		if (t.startsWith("|")) { if (start < 0) start = i; end = i; }
		else if (start >= 0) break; // blank/non-table line after the table → table ended
	}
	if (start < 0) return overviewText; // heading but no table
	const cell = formatBlockerList(nums, (n) => String(n));
	const headerCols = lines[start].split("|").slice(1, -1).length;
	const isMeta = (c0: string): boolean => /concern/i.test(c0) || /^[-:\s]+$/.test(c0);

	let rowIdx = -1;
	for (let i = start; i <= end; i++) {
		const cols = lines[i].split("|").slice(1, -1).map((c) => c.trim());
		if (cols.length < 2 || isMeta(cols[0])) continue;
		if (Number((/\d{1,3}/.exec(cols[0]) ?? [])[0]) === num) { rowIdx = i; break; }
	}
	if (rowIdx >= 0) {
		const lead = lines[rowIdx].match(/^\s*/)?.[0] ?? "";
		const cols = lines[rowIdx].split("|").slice(1, -1).map((c) => c.trim());
		cols[1] = cell;
		lines[rowIdx] = `${lead}| ${cols.join(" | ")} |`;
	} else {
		const cols = new Array(Math.max(headerCols, 2)).fill("—");
		cols[0] = String(num);
		cols[1] = cell;
		const lead = lines[end].match(/^\s*/)?.[0] ?? "";
		lines.splice(end + 1, 0, `${lead}| ${cols.join(" | ")} |`);
	}
	return lines.join(eol);
}

/** Parse one dependency-graph BLOCKED_BY cell ("none", "01, 03", "concern #2") into concern numbers. */
function parseBlockerNums(cell: string): number[] {
	if (/^(?:none|—|-)?$/i.test(cell.trim())) return [];
	return [...new Set([...cell.matchAll(/\d{1,3}/g)].map((m) => Number(m[0])).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
}

/** Read a plan's "Dependency graph" table as concern number → blocking concern numbers. */
export async function parsePlanDependencyGraph(repo: string, planDir: string): Promise<Map<number, number[]>> {
	const dirAbs = path.join(repo, planDir);
	const ov = await findOverviewFile(dirAbs);
	if (!ov) return new Map();
	const text = await fs.readFile(path.join(dirAbs, ov), "utf8").catch(() => "");
	const lines = text.split(/\r?\n/);
	const headingIdx = lines.findIndex((l) => /^#{1,6}\s*Dependency graph/i.test(l.trim()));
	if (headingIdx < 0) return new Map();
	let start = -1;
	let end = -1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const t = lines[i].trim();
		if (/^#{1,6}\s/.test(t)) break;
		if (t.startsWith("|")) { if (start < 0) start = i; end = i; }
		else if (start >= 0) break;
	}
	if (start < 0) return new Map();
	const out = new Map<number, number[]>();
	for (let i = start; i <= end; i++) {
		const cols = lines[i].split("|").slice(1, -1).map((c) => c.trim());
		if (cols.length < 2 || /concern/i.test(cols[0]) || /^[-:\s]+$/.test(cols[0])) continue;
		const num = Number((/\d{1,3}/.exec(cols[0]) ?? [])[0]);
		if (Number.isFinite(num)) out.set(num, parseBlockerNums(cols[1]));
	}
	return out;
}

/** Find a plan dir's overview file (00-overview.md preferred), or null. */
async function findOverviewFile(dirAbs: string): Promise<string | null> {
	const files = await fs.readdir(dirAbs).catch(() => [] as string[]);
	return files.find((f) => /^0*0[-_.]?overview\.md$/i.test(f)) ?? files.find((f) => /overview\.md$/i.test(f)) ?? null;
}

export interface ConcernPatch {
	status?: string;
	blockedBy?: number[];
}

/**
 * Apply a flow-diagram edit to one concern: rewrite its STATUS/BLOCKED_BY in the concern doc
 * and, when blockers change, the matching row of the overview "Dependency graph" table. Returns
 * the re-parsed concern, or undefined when `file` isn't a writable concern in this plan dir.
 */
export async function updatePlanConcern(repo: string, planDir: string, file: string, patch: ConcernPatch): Promise<PlanConcern | undefined> {
	const base = path.basename(file); // strip any dir component → no traversal out of the plan dir
	if (!base.toLowerCase().endsWith(".md") || CONCERN_SKIP.has(base.toLowerCase())) return undefined;
	const dirAbs = path.join(repo, planDir);
	const concernAbs = path.join(dirAbs, base);
	let text: string;
	try { text = await fs.readFile(concernAbs, "utf8"); } catch { return undefined; }
	if (!(C_STATUS.exec(text) ?? C_STATUS_BOLD.exec(text) ?? C_STATUS_H2.exec(text))) return undefined; // not a concern

	let next = text;
	if (patch.status != null) next = setConcernStatus(next, patch.status);
	if (patch.blockedBy != null) next = setConcernBlockedBy(next, patch.blockedBy);
	if (next !== text) await fs.writeFile(concernAbs, next, "utf8");

	if (patch.blockedBy != null) {
		const num = concernNumFromFile(base);
		const ov = num != null ? await findOverviewFile(dirAbs) : null;
		if (ov && num != null) {
			const ovAbs = path.join(dirAbs, ov);
			const ovText = await fs.readFile(ovAbs, "utf8").catch(() => "");
			const ovNext = setOverviewDepRow(ovText, num, patch.blockedBy);
			if (ovNext !== ovText) await fs.writeFile(ovAbs, ovNext, "utf8");
		}
	}

	return (await parsePlanConcerns(repo, planDir)).find((c) => c.file === base);
}

// ── concern decision-log appends (QuestionsBlock answers) ─────────────────────
//
// An answered Open Question is persisted as a resolved decision: we append a
// `- Q: <prompt> — A: <value>` bullet to the concern doc's `## Decisions` section
// (the same heading set markdownSectionItems reads into PlanConcern.decisions), so
// the answer is git-committed, reparsed, and visible to the worktree agent + Plane.

const DECISION_HEADINGS = new Set(["decisions", "decision log", "rationale"]);

/** Append `line` as a `- <line>` bullet under the concern's Decisions section (idempotent: an
 *  identical bullet is never duplicated). Creates the section if absent. Pure string surgery. */
export function appendDecisionLine(text: string, line: string): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const bullet = `- ${line}`;
	const lines = text.split(/\r?\n/);

	// Locate the Decisions section and its end (the last non-blank line before the next heading/EOF).
	let headingIdx = -1;
	let lastContentIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(lines[i]);
		if (heading) {
			if (headingIdx >= 0) break; // reached the section after Decisions
			if (DECISION_HEADINGS.has(heading[2].replace(/[:#]+$/g, "").trim().toLowerCase())) { headingIdx = i; lastContentIdx = i; }
			continue;
		}
		if (headingIdx >= 0 && lines[i].trim()) lastContentIdx = i;
	}

	if (headingIdx >= 0) {
		// Idempotency: same bullet already present in this section.
		for (let i = headingIdx + 1; i <= lastContentIdx; i++) {
			if (lines[i].trim() === bullet) return text;
		}
		lines.splice(lastContentIdx + 1, 0, bullet);
		return lines.join(eol);
	}

	// No Decisions section: append one at the end of the file.
	const trimmed = text.replace(/\s+$/, "");
	return `${trimmed}${eol}${eol}## Decisions${eol}${eol}${bullet}${eol}`;
}

/**
 * Append an answered Open Question to a concern's Decisions log. `file` is the concern path relative
 * to `repo` (PlanConcern.path), e.g. "plans/foo/03-bar.md". Reads the file, appends `- <line>` under
 * its `## Decisions`/`## Decision Log`/`## Rationale` section (creating it if absent), writes it back,
 * and returns the reparsed concern — or null when the file is missing or isn't a concern. Idempotent.
 */
export async function appendConcernDecision(repo: string, file: string, line: string): Promise<PlanConcern | null> {
	const rel = file.replace(/^[/\\]+/, "");
	const planDir = path.dirname(rel);
	const base = path.basename(rel);
	if (!base.toLowerCase().endsWith(".md") || CONCERN_SKIP.has(base.toLowerCase())) return null;
	const concernAbs = path.join(repo, planDir, base);
	let text: string;
	try { text = await fs.readFile(concernAbs, "utf8"); } catch { return null; }

	const next = appendDecisionLine(text, line);
	if (next !== text) await fs.writeFile(concernAbs, next, "utf8");

	return (await parsePlanConcerns(repo, planDir)).find((c) => c.file === base) ?? null;
}

function countStatuses(agents: AgentDTO[]): Partial<Record<AgentStatus, number>> {
	const counts: Partial<Record<AgentStatus, number>> = {};
	for (const a of agents) counts[a.status] = (counts[a.status] ?? 0) + 1;
	return counts;
}

function deriveStage(opts: { agents: AgentDTO[]; worktrees: FeatureWorktreeStatus[]; unlanded: number; planDir?: string; hasIssues: boolean }): FeatureStage {
	if (opts.worktrees.some((w) => w.readiness === "diverged")) return "diverged";
	if (opts.agents.some((a) => a.status === "working" || a.status === "starting")) return "in-progress";
	const needsLand = opts.unlanded > 0 || opts.worktrees.some((w) => w.readiness === "ahead" || w.readiness === "uncommitted");
	if (needsLand) return "review";
	if (opts.agents.length > 0) return "landed";
	if (opts.planDir !== undefined) return opts.hasIssues ? "issues-created" : "planned";
	return "planned";
}

/** Map a research-plan-implement workflow node label to the coarse board stage (the granular node label rides FeatureDTO.workflowStage). */
const WF_STAGE: Record<string, FeatureStage> = {
	Research: "planned",
	Plan: "planned",
	"Approve plan": "planned",
	"File to Plane": "issues-created",
	Implement: "in-progress",
	Verify: "review",
	Fixup: "review",
};

function planCriteria(concerns: PlanConcern[], progress?: { done: number; total: number }): FeatureCriterion[] {
	const fromPlan = concerns.flatMap((concern) => {
		const items = concern.acceptanceCriteria.length ? concern.acceptanceCriteria : [`${concern.title} reaches ${concern.status}`];
		return items.map((text, index): FeatureCriterion => ({ id: `${concern.file}:${index}`, text, completed: !concern.open, source: "plan" }));
	});
	return progress && progress.total > 0
		? [{ id: "workflow-progress", text: `Workflow progress ${progress.done} / ${progress.total}`, completed: progress.done >= progress.total, source: "workflow" }, ...fromPlan]
		: fromPlan;
}

function planDecisions(concerns: PlanConcern[]): FeatureDecision[] {
	return concerns.flatMap((concern) => concern.decisions.map((text, index): FeatureDecision => ({ id: `${concern.file}:decision:${index}`, text, source: "plan" })));
}

function issueRelationships(issueIds: string[]): FeatureRelationship[] {
	return issueIds.map((identifier) => ({ id: identifier, targetId: identifier, targetTitle: identifier, type: "issue" }));
}

function mergeIssueRelationships(existing: FeatureRelationship[] | undefined, issueIds: string[]): FeatureRelationship[] {
	const out = [...(existing ?? [])];
	const seen = new Set(out.flatMap((rel) => [rel.id, rel.targetId]));
	for (const rel of issueRelationships(issueIds)) {
		if (seen.has(rel.id) || seen.has(rel.targetId)) continue;
		out.push(rel);
		seen.add(rel.id);
		seen.add(rel.targetId);
	}
	return out;
}

function derivedDescription(opts: { stage: FeatureStage; repo: string; planDir?: string; issueIds: string[]; agents: AgentDTO[]; workflowStage?: string; blocked: boolean; divergent: boolean }): string {
	const lines = [`Repo: ${opts.repo}`];
	if (opts.planDir) lines.push(`Plan: ${opts.planDir}`);
	if (opts.issueIds.length) lines.push(`Issues: ${opts.issueIds.join(", ")}`);
	if (opts.agents.length) lines.push(`Agents: ${opts.agents.map((agent) => `${agent.name} (${agent.status})`).join(", ")}`);
	if (opts.workflowStage) lines.push(`Workflow: ${opts.workflowStage}`);
	if (opts.blocked) lines.push("Blocked: yes");
	if (opts.divergent) lines.push("Diverged: yes");
	return lines.join("\n");
}

function contextSummary(opts: { planDir?: string; concerns: PlanConcern[]; issueIds: string[]; agents: AgentDTO[]; workflowProgress?: { done: number; total: number }; workflowStage?: string; blocked: boolean; decisions: FeatureDecision[]; override?: Partial<FeatureContextSummary> }): FeatureContextSummary {
	if (opts.concerns.length) return planContextSummary(opts);
	const blockedAgents = opts.agents.filter((agent) => agent.status === "input").length;
	return {
		spec: opts.override?.spec ?? opts.planDir ?? "live feature",
		criteria: opts.override?.criteria ?? (opts.workflowProgress ? `${opts.workflowProgress.done} / ${opts.workflowProgress.total} workflow steps` : `${opts.issueIds.length} linked issues`),
		prerequisites: opts.override?.prerequisites ?? (blockedAgents ? `${blockedAgents} agent${blockedAgents === 1 ? "" : "s"} waiting for input` : opts.blocked ? "blocked" : "no known blockers"),
		decisions: opts.override?.decisions ?? (opts.decisions.length ? `${opts.decisions.length} recorded decision${opts.decisions.length === 1 ? "" : "s"}` : opts.workflowStage ?? "no recorded decisions"),
		downstream: opts.override?.downstream ?? (opts.agents.length ? `${opts.agents.length} active agent${opts.agents.length === 1 ? "" : "s"}` : "no active agents"),
	};
}

function planContextSummary(opts: { planDir?: string; concerns: PlanConcern[]; issueIds: string[]; agents: AgentDTO[]; workflowProgress?: { done: number; total: number }; workflowStage?: string; blocked: boolean; decisions: FeatureDecision[] }): FeatureContextSummary {
	const open = opts.concerns.filter((concern) => concern.open);
	const titles = summarizeItems(open.map((concern) => concern.title), "all plan concerns closed");
	const criteria = summarizeItems(opts.concerns.flatMap((concern) => concern.acceptanceCriteria.map((item) => `${concern.title}: ${item}`)), "no acceptance criteria in plan");
	const prerequisites = summarizeItems(opts.concerns.flatMap((concern) => concern.prerequisites.map((item) => `${concern.title}: ${item}`)), opts.blocked ? "blocked" : "no plan blockers");
	const decisions = summarizeItems(opts.decisions.map((decision) => decision.text), opts.workflowStage ?? "no plan decisions");
	const touches = summarizeItems(opts.concerns.flatMap((concern) => concern.touches), opts.issueIds.length ? opts.issueIds.join(", ") : "no downstream files listed");
	return {
		spec: `${opts.planDir ?? "plan"} · ${open.length}/${opts.concerns.length} open · ${titles}`,
		criteria: opts.workflowProgress ? `${opts.workflowProgress.done}/${opts.workflowProgress.total} workflow steps · ${criteria}` : criteria,
		prerequisites,
		decisions,
		downstream: opts.agents.length ? `${touches} · ${opts.agents.length} active agent${opts.agents.length === 1 ? "" : "s"}` : touches,
	};
}

function summarizeItems(items: string[], empty: string): string {
	const uniq = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
	return uniq.length > 2 ? `${uniq.slice(0, 2).join("; ")}; +${uniq.length - 2} more` : (uniq.join("; ") || empty);
}

export function featureProofAggregate(worktrees: FeatureWorktreeStatus[]): FeatureProofAggregate {
	const out: FeatureProofAggregate = { fresh: 0, failed: 0, stale: 0, none: 0, artifacts: 0 };
	for (const wt of worktrees) {
		const proof = wt.proof;
		out[proof?.state ?? "none"] += 1;
		out.artifacts += proof?.artifacts ?? 0;
		if (proof?.ranAt && (!out.latestRanAt || proof.ranAt > out.latestRanAt)) out.latestRanAt = proof.ranAt;
	}
	return out;
}

export function featureReadiness(feature: Pick<FeatureDTO, "stage" | "blocked" | "worktrees">): FeatureReadiness {
	if (feature.stage === "done") return { ready: false, state: "done", blockers: [], nextAction: "Feature is already done." };
	if (feature.stage === "landed") return { ready: false, state: "landed", blockers: [], nextAction: "Review landed work and mark done." };
	if (!feature.worktrees.length) return { ready: false, state: "no-candidate", blockers: ["no-candidate"], nextAction: "Start or attach candidate work." };
	if (feature.blocked) return { ready: false, state: "blocked-input", blockers: ["blocked-input"], nextAction: "Answer the blocked agent request." };
	const bad = feature.worktrees.find((wt) => wt.readiness === "diverged" || wt.readiness === "uncommitted" || wt.readiness === "no-branch");
	if (bad?.readiness === "diverged") return { ready: false, state: "diverged", blockers: ["diverged"], nextAction: "Resolve branch divergence before landing." };
	if (bad?.readiness === "uncommitted") return { ready: false, state: "uncommitted", blockers: ["uncommitted"], nextAction: "Commit or discard worktree changes." };
	if (bad?.readiness === "no-branch") return { ready: false, state: "diverged", blockers: ["no-branch"], nextAction: "Put candidate work on a branch." };
	const proof = featureProofAggregate(feature.worktrees.filter((wt) => wt.readiness === "ahead" || wt.readiness === "clean" || wt.readiness === "merged"));
	if (proof.failed) return { ready: false, state: "proof-failed", blockers: ["proof-failed"], nextAction: "Fix the failing proof command." };
	if (proof.stale) return { ready: false, state: "proof-stale", blockers: ["proof-stale"], nextAction: "Re-run proof against current HEAD." };
	if (proof.none) return { ready: false, state: "needs-proof", blockers: ["needs-proof"], nextAction: "Run feature verification proof." };
	return { ready: true, state: "ready", blockers: [], nextAction: "Land the verified candidate." };
}

/** Build the feature list for one repo: persisted features (explicit membership) + unadopted plan dirs + unassigned agents. */
export async function buildFeatures(repo: string, agents: AgentDTO[], persisted: PersistedFeature[] = [], operatorId = "local"): Promise<FeatureDTO[]> {
	const features: FeatureDTO[] = [];
	const assigned = new Set<string>();
	const adoptedDirs = new Set<string>();
	const planDirs = await listPlanDirs(repo);
	const planDirByPath = new Map(planDirs.map((pd) => [pd.dir, pd]));

	// Compare NORMALIZED: features persisted before `createFeature` normalized (and any written by an
	// older daemon) still carry the caller's raw spelling, while callers now address them by the
	// normalized project id. A literal `!==` silently excluded them. (gpt-5.6-sol)
	const repoKey = normalizeRepoPath(repo);
	for (const pf of persisted) {
		if (normalizeRepoPath(pf.repo) !== repoKey) continue;
		if (pf.origin?.planDir) adoptedDirs.add(pf.origin.planDir);
		if (pf.archived) continue;
		const members = agents.filter((a) => a.featureId === pf.id);
		for (const m of members) assigned.add(m.id);
		// Live members + cached branches for members no longer in the roster (so land status survives agent removal).
		const land: LandMember[] = members.map((a) => ({ agentId: a.id, agentName: a.name, branch: a.branch, worktree: a.worktree, repo }));
		for (const b of pf.branches ?? []) {
			if (!members.some((m) => m.id === b.agentId)) land.push({ agentId: b.agentId, branch: b.branch, worktree: b.worktree, repo });
		}
		const worktrees = await featureLandStatus(land);
		const unlandedFiles = worktrees.reduce((s, w) => s + w.changedFiles, 0);
		// Issue links are derived live from the plan dir (so an adopted plan keeps its PLANE: pointers), merged with any persisted ones.
		const liveIssueIds = pf.origin?.planDir ? await planeIdsIn(path.join(repo, pf.origin.planDir)) : [];
		const issueIds = [...new Set([...(pf.plane?.issueIdentifiers ?? []), ...liveIssueIds])];
		const hasIssues = issueIds.length > 0;
		// When Fabro-driven, the live workflow node drives the stage (more granular than evidence while the run is active).
		const wfAgent = pf.workflowAgentId ? members.find((a) => a.id === pf.workflowAgentId) : undefined;
		const wfActive = wfAgent?.todo?.active;
		const wfStage = wfActive ? WF_STAGE[wfActive] : undefined;
		const concerns = pf.origin?.planDir ? await parsePlanConcerns(repo, pf.origin.planDir) : [];
		const workflowProgress = wfAgent?.todo ? { done: wfAgent.todo.done, total: wfAgent.todo.total } : undefined;
		const workflowProof = wfAgent ? worktrees.find((w) => w.agentId === wfAgent.id)?.proof : undefined;
		const decisions = pf.decisions ?? planDecisions(concerns);
		const relationships = mergeIssueRelationships(pf.relationships, issueIds);
		const stage = pf.stageOverride ?? wfStage ?? deriveStage({ agents: members, worktrees, unlanded: unlandedFiles, planDir: pf.origin?.planDir, hasIssues });
		const divergent = worktrees.some((w) => w.readiness === "diverged");
		const blocked = members.some((a) => a.status === "input");
		const planTitle = pf.origin?.planDir ? planDirByPath.get(pf.origin.planDir)?.title : undefined;
		const title = planTitle && weakPlanTitle(pf.title, pf.origin?.planDir ?? "") ? planTitle : pf.title;
		const description = persistedDescription(pf.description) ?? derivedDescription({ stage, repo, planDir: pf.origin?.planDir, issueIds, agents: members, workflowStage: wfActive, blocked, divergent });
		const readiness = featureReadiness({ stage, worktrees, blocked });
		features.push({
			id: pf.id,
			title,
			createdAt: pf.createdAt,
			updatedAt: pf.updatedAt,
			repo,
			stage,
			planDir: pf.origin?.planDir,
			agentIds: members.map((a) => a.id),
			// Backward-compatible: a feature persisted before assignees existed (or with an empty array)
			// defaults to the single operator identity so the vote substrate is never A=0.
			assignees: pf.assignees && pf.assignees.length ? pf.assignees : [operatorId],
			worktrees,
			unlandedFiles,
			divergent,
			blocked,
			statusCounts: countStatuses(members),
			issueIdentifiers: hasIssues ? issueIds : undefined,
			persisted: true,
			stageOverride: pf.stageOverride,
			category: pf.category,
			workflowAgentId: pf.workflowAgentId,
			workflowStage: wfActive,
			workflowProgress,
			workflowProof,
			description,
			acceptanceCriteria: pf.acceptanceCriteria ?? planCriteria(concerns, workflowProgress),
			decisions,
			relationships,
			readiness,
			contextBundle: contextSummary({ planDir: pf.origin?.planDir, concerns, issueIds, agents: members, workflowProgress, workflowStage: wfActive, blocked, decisions, override: pf.contextBundle }),
			proof: featureProofAggregate(worktrees),
		});
	}

	for (const pd of planDirs) {
		if (adoptedDirs.has(pd.dir)) continue;
		const concerns = await parsePlanConcerns(repo, pd.dir);
		const decisions = planDecisions(concerns);
		const stage = deriveStage({ agents: [], worktrees: [], unlanded: 0, planDir: pd.dir, hasIssues: pd.issueIds.length > 0 });
		const readiness = featureReadiness({ stage, worktrees: [], blocked: false });
		features.push({
			id: `plan:${repo}:${pd.dir}`,
			title: pd.title,
			createdAt: pd.createdAt,
			updatedAt: pd.updatedAt,
			repo,
			stage,
			planDir: pd.dir,
			agentIds: [],
			assignees: [operatorId],
			worktrees: [],
			unlandedFiles: 0,
			divergent: false,
			blocked: false,
			statusCounts: {},
			issueIdentifiers: pd.issueIds.length > 0 ? pd.issueIds : undefined,
			description: derivedDescription({ stage, repo, planDir: pd.dir, issueIds: pd.issueIds, agents: [], blocked: false, divergent: false }),
			acceptanceCriteria: planCriteria(concerns),
			decisions,
			relationships: issueRelationships(pd.issueIds),
			readiness,
			contextBundle: contextSummary({ planDir: pd.dir, concerns, issueIds: pd.issueIds, agents: [], blocked: false, decisions }),
			proof: featureProofAggregate([]),
		});
	}

	for (const a of agents) {
		if (assigned.has(a.id)) continue;
		const worktrees = await featureLandStatus([{ agentId: a.id, agentName: a.name, branch: a.branch, worktree: a.worktree, repo }]);
		const unlandedFiles = worktrees.reduce((s, w) => s + w.changedFiles, 0);
		const issueIds = a.issue?.identifier ? [a.issue.identifier] : [];
		const stage = deriveStage({ agents: [a], worktrees, unlanded: unlandedFiles, hasIssues: false });
		const divergent = worktrees.some((w) => w.readiness === "diverged");
		const blocked = a.status === "input";
		const decisions: FeatureDecision[] = [];
		const readiness = featureReadiness({ stage, worktrees, blocked });
		features.push({
			id: `agent:${a.id}`,
			title: a.name,
			repo,
			stage,
			agentIds: [a.id],
			assignees: [operatorId],
			worktrees,
			unlandedFiles,
			divergent,
			blocked,
			statusCounts: countStatuses([a]),
			issueIdentifiers: issueIds.length ? issueIds : undefined,
			description: derivedDescription({ stage, repo, issueIds, agents: [a], blocked, divergent }),
			acceptanceCriteria: [],
			decisions,
			relationships: issueRelationships(issueIds),
			readiness,
			contextBundle: contextSummary({ issueIds, concerns: [], agents: [a], blocked, decisions }),
			proof: featureProofAggregate(worktrees),
		});
	}

	for (const feature of features) feature.readiness = featureReadiness(feature);
	return features;
}

/** Order branches for a Land-all: fast-forward-safe (ahead) first, then uncommitted; clean/diverged/no-branch excluded. */
export function landOrder(worktrees: FeatureWorktreeStatus[]): FeatureWorktreeStatus[] {
	const rank = (r: LandReadiness): number => (r === "ahead" ? 0 : r === "uncommitted" ? 1 : 2);
	return worktrees.filter((w) => w.readiness === "ahead" || w.readiness === "uncommitted").sort((a, b) => rank(a.readiness) - rank(b.readiness));
}
