/**
 * Plan-doc writer — materializes `ConcernDraft[]` (planner.ts) into `plans/<name>/NN-slug.md`
 * concern docs + a `00-overview.md` carrying the "## Dependency graph" table, idempotently
 * and behind the existing DAG gate (`validatePlanConcerns`, features.ts:410 — reused, not
 * re-implemented). Write → validate → rollback: a cyclic/dangling plan never survives on disk.
 *
 * One-directional STATUS discipline, mirroring plan-sync.ts's own one-way transitions: a
 * concern file that already carries a TERMINAL status is FROZEN — its number, title, body, and
 * STATUS are never touched again, and it is never removed. A drafted concern that would otherwise
 * land on a frozen (or caller-protected) number is transparently renumbered onto a free one
 * instead of being mistaken for "refining" it (see `remapAroundReserved`). `OBJECTIVE.md` and
 * `DESIGN.md` are never touched — the former is the resident planner's input marker
 * (resident-planner.ts owns reading it).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ConcernDraft } from "./planner.ts";
import { concernNumFromFile, parsePlanConcerns, parsePlanDependencyGraph, validatePlanConcerns, type PlanConcern } from "./features.ts";
import type { PlanGraphIssue } from "../webapp/src/lib/planGraph.ts";

/** Mirrors plan-sync.ts's own local TERMINAL set (not exported there) — the STATUS values
 *  that mean "this concern's work is finished" and must never be rewritten or pruned. */
const TERMINAL = new Set(["done", "complete", "completed", "closed", "cancelled", "canceled"]);
/** Files the writer must never read from, write to, or delete — the resident planner's
 *  input marker and the human-authored design doc. */
const PROTECTED_FILES = new Set(["objective.md", "design.md"]);
const OVERVIEW_FILE = "00-overview.md";

export interface WriteConcernDraftsOpts {
	/** Existing concern numbers that must survive even if absent from `drafts` and non-terminal
	 *  by STATUS — e.g. a concern verified via a DoneProof the writer has no visibility into
	 *  (only the loop knows the proof ledger; STATUS alone can't tell "verified" from "obsolete"
	 *  during the window before plan-sync's own, slower reconciliation flips its STATUS to done). */
	protectedNums?: Iterable<number>;
}

export interface WriteResult {
	/** Files created or whose content changed this call. */
	written: string[];
	/** Files deleted this call (pruned open orphans, or stale filenames from a slug rename). */
	removed: string[];
	/** Non-empty ⇒ the DAG gate refused the write; the plan dir was rolled back to its pre-write state. */
	issues: PlanGraphIssue[];
	ok: boolean;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function draftFilename(d: ConcernDraft): string {
	return `${pad(d.num)}-${d.slug}.md`;
}

function renderConcern(d: ConcernDraft, status: string, planeId?: string): string {
	const touches = d.touches.join(", ");
	const acceptance = d.acceptance.map((a) => `- ${a}`).join("\n");
	// A concern already filed to Plane carries a PLANE: pointer the dispatch/plan-sync pipeline
	// depends on — refining its body must never silently drop that pointer. The planner itself
	// never emits one for a brand-new concern (planeId is undefined ⇒ no line).
	const planeLine = planeId ? `\nPLANE: ${planeId}` : "";
	return `# ${d.title}

STATUS: ${status}
PRIORITY: ${d.priority}
COMPLEXITY: ${d.complexity}
TOUCHES: ${touches}${planeLine}

## Goal

${d.goal}

## Approach

${d.approach}

## Acceptance Criteria

${acceptance}
`;
}

function formatBlockedByCell(nums: number[]): string {
	const uniq = [...new Set(nums)].sort((a, b) => a - b);
	return uniq.length ? uniq.join(", ") : "none";
}

function renderOverview(planTitle: string, rows: { num: number; title: string; blockedBy: number[] }[]): string {
	const sorted = [...rows].sort((a, b) => a.num - b.num);
	const lines = [
		`# ${planTitle}`,
		"",
		"## Dependency graph",
		"",
		"| Concern | BLOCKED_BY |",
		"|---|---|",
		...sorted.map((r) => `| ${r.num} ${r.title} | ${formatBlockedByCell(r.blockedBy)} |`),
		"",
	];
	return lines.join("\n");
}

/** Every non-protected `.md` file's current content, for rollback. */
async function snapshotDir(dirAbs: string): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	let files: string[];
	try {
		files = (await fs.readdir(dirAbs)).filter((f) => f.endsWith(".md"));
	} catch {
		return snapshot;
	}
	for (const f of files) {
		if (PROTECTED_FILES.has(f.toLowerCase())) continue;
		const content = await fs.readFile(path.join(dirAbs, f), "utf8").catch(() => undefined);
		if (content !== undefined) snapshot.set(f, content);
	}
	return snapshot;
}

/** Restore `dirAbs` to exactly the state captured in `before` — rewrite every snapshotted file
 *  verbatim, delete anything non-protected that exists now but wasn't in the snapshot. */
async function rollback(dirAbs: string, before: Map<string, string>): Promise<void> {
	for (const [file, content] of before) {
		await fs.writeFile(path.join(dirAbs, file), content, "utf8").catch(() => {});
	}
	const current = await fs.readdir(dirAbs).catch(() => [] as string[]);
	for (const file of current) {
		if (!file.endsWith(".md") || PROTECTED_FILES.has(file.toLowerCase())) continue;
		if (!before.has(file)) await fs.rm(path.join(dirAbs, file), { force: true }).catch(() => {});
	}
}

/**
 * Shift any drafted concern number that collides with a `reserved` number onto the lowest free
 * slot, remapping its IN-BATCH `blockedBy` refs (which name other drafts) along with it. A number
 * is "reserved" once anything frozen (a terminal concern, or a caller-protected one) already owns
 * it — no draft may ever be mistaken for "refining" it. `parseConcernDrafts` (planner.ts) densely
 * renumbers the model's ENTIRE batch from 1 on every call, blind to what's already resident on
 * disk; without this remap, a shrinking frontier routinely renumbers back down onto a concern
 * number a still-open (or already-terminal) existing file owns, and a naive "same number ⇒ same
 * concern" match would silently overwrite it with unrelated content.
 *
 * `blockedByExternal` is NEVER touched here: those refs name concerns that already exist on disk,
 * not drafts, so they must stay fixed. This is the SIG-1 fix — the in-batch vs external
 * distinction is carried through from parseConcernDrafts as two separate number lists rather than
 * guessed from the number here, so a genuine sibling edge whose number happens to equal a
 * reserved concern's number still follows the remap (it lives in `blockedBy`) while a true
 * external edge to that reserved concern stays put (it lives in `blockedByExternal`). Pure — no I/O. */
function remapAroundReserved(drafts: ConcernDraft[], reserved: Set<number>): ConcernDraft[] {
	if (reserved.size === 0) return drafts;
	const used = new Set(reserved);
	for (const d of drafts) if (!reserved.has(d.num)) used.add(d.num);

	let next = 1;
	const freeNum = (): number => {
		while (used.has(next)) next++;
		used.add(next);
		return next;
	};

	const remap = new Map<number, number>();
	for (const d of drafts) if (reserved.has(d.num)) remap.set(d.num, freeNum());
	if (remap.size === 0) return drafts;
	return drafts.map((d) => ({
		...d,
		num: remap.get(d.num) ?? d.num,
		blockedBy: d.blockedBy.map((b) => remap.get(b) ?? b),
		// external refs name on-disk concerns, never drafts — remapping a draft must never move them.
		blockedByExternal: d.blockedByExternal,
	}));
}

/** The full blocker set a concern's overview row must list: its in-batch sibling refs plus its
 *  external (on-disk concern) refs, deduped + sorted. Both resolve to real concern numbers. */
function allBlockers(d: ConcernDraft): number[] {
	return [...new Set([...d.blockedBy, ...d.blockedByExternal])].sort((a, b) => a - b);
}

export async function writeConcernDrafts(repo: string, planDir: string, rawDrafts: ConcernDraft[], opts: WriteConcernDraftsOpts = {}): Promise<WriteResult> {
	const dirAbs = path.join(repo, planDir);
	const protectedNums = new Set(opts.protectedNums ?? []);
	await fs.mkdir(dirAbs, { recursive: true }).catch(() => {});

	const before = await snapshotDir(dirAbs);
	const existingAll = await parsePlanConcerns(repo, planDir);
	// Defensive: OBJECTIVE.md/DESIGN.md never carry a STATUS line so parsePlanConcerns already
	// skips them, but never let a stray match make it into the writer's own logic either.
	const existing = existingAll.filter((c) => !PROTECTED_FILES.has(c.file.toLowerCase()));
	const oldDepGraph = await parsePlanDependencyGraph(repo, planDir);

	const existingByNum = new Map<number, PlanConcern>();
	const terminalNums = new Set<number>();
	for (const c of existing) {
		const n = concernNumFromFile(c.file);
		if (n == null) continue;
		if (!existingByNum.has(n)) existingByNum.set(n, c);
		if (TERMINAL.has(c.status)) terminalNums.add(n);
	}

	// A terminal (or caller-protected) concern's number is frozen — never reassigned to a
	// different draft, so its file (title, body, STATUS — everything) is never touched again.
	const reserved = new Set<number>([...protectedNums, ...terminalNums]);
	const drafts = remapAroundReserved(rawDrafts, reserved);
	const draftNums = new Set(drafts.map((d) => d.num));
	const written: string[] = [];
	const removed: string[] = [];

	// 1. Write/refresh every drafted concern. Post-remap, no draft can land on a reserved number,
	// so any existingByNum match here is by construction non-terminal, non-protected — always the
	// "refine this still-open concern in place" case, never a frozen one.
	for (const draft of drafts) {
		const existingConcern = existingByNum.get(draft.num);
		const filename = draftFilename(draft);
		// Only inherit the PLANE pointer when this draft is GENUINELY the same concern being refined
		// in place — same file (num+slug), not merely a different concern that landed on the same
		// number after renumbering. Otherwise a new concern reusing a to-be-replaced slot would
		// silently claim the old concern's Plane issue (m2).
		const inheritedPlaneId = existingConcern && existingConcern.file === filename ? existingConcern.planeId : undefined;
		const content = renderConcern(draft, "open", inheritedPlaneId);
		const targetPath = path.join(dirAbs, filename);
		const current = await fs.readFile(targetPath, "utf8").catch(() => undefined);
		if (current !== content) {
			await fs.writeFile(targetPath, content, "utf8");
			written.push(filename);
		}
		// A concern whose slug changed vacates its old filename.
		if (existingConcern && existingConcern.file !== filename) {
			await fs.rm(path.join(dirAbs, existingConcern.file), { force: true }).catch(() => {});
			removed.push(existingConcern.file);
		}
	}

	// 2. Prune open orphans: existing non-reserved concerns whose num the new drafts dropped
	// (the frontier shrank). Terminal or explicitly-protected concerns always survive, whether or
	// not they're redrafted.
	for (const c of existing) {
		const n = concernNumFromFile(c.file);
		if (n == null || draftNums.has(n) || reserved.has(n)) continue;
		await fs.rm(path.join(dirAbs, c.file), { force: true }).catch(() => {});
		removed.push(c.file);
	}

	// 3. Overview: a row for every concern that exists after this write — drafted ones plus
	// preserved terminal/protected ones the drafts didn't touch (so the DAG gate can resolve
	// blockedBy refs pointing at them). A preserved row keeps its previous blockers verbatim.
	const rows: { num: number; title: string; blockedBy: number[] }[] = drafts.map((d) => ({ num: d.num, title: d.title, blockedBy: allBlockers(d) }));
	for (const c of existing) {
		const n = concernNumFromFile(c.file);
		if (n == null || draftNums.has(n) || !reserved.has(n)) continue;
		rows.push({ num: n, title: c.title, blockedBy: oldDepGraph.get(n) ?? [] });
	}
	const overviewContent = renderOverview(humanPlanTitle(planDir), rows);
	const overviewPath = path.join(dirAbs, OVERVIEW_FILE);
	const currentOverview = await fs.readFile(overviewPath, "utf8").catch(() => undefined);
	if (currentOverview !== overviewContent) {
		await fs.writeFile(overviewPath, overviewContent, "utf8");
		written.push(OVERVIEW_FILE);
	}

	// 4. Gate: reuse validatePlanConcerns (features.ts:410) — do not re-implement cycle/dangling
	// detection. A cyclic/dangling plan never survives on disk.
	const issues = await validatePlanConcerns(repo, planDir);
	if (issues.length > 0) {
		await rollback(dirAbs, before);
		return { written: [], removed: [], issues, ok: false };
	}

	return { written, removed, issues: [], ok: true };
}

function humanPlanTitle(planDir: string): string {
	return path
		.basename(planDir)
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
