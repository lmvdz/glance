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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { worktreeDiff } from "./explore.ts";
import type { AgentDTO, AgentStatus, FeatureDTO, FeatureStage, FeatureWorktreeStatus, LandReadiness, PersistedFeature } from "./types.ts";

function git(cwd: string, args: string[]): string | undefined {
	try {
		const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
		if (r.exitCode !== 0) return undefined;
		return r.stdout.toString().trim();
	} catch {
		return undefined;
	}
}

/** Commits on `branch` not in main (ahead) and on main not in `branch` (behind). */
function aheadBehind(repo: string, branch: string): { ahead: number; behind: number } {
	const out = git(repo, ["rev-list", "--left-right", "--count", `HEAD...${branch}`]);
	if (out === undefined) return { ahead: 0, behind: 0 };
	const parts = out.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
	return { behind: parts[0] ?? 0, ahead: parts[1] ?? 0 };
}

/** True if merging `branch` into main would conflict (git >= 2.38 merge-tree); undefined if unsupported. */
function predictsConflict(repo: string, branch: string): boolean | undefined {
	try {
		const r = Bun.spawnSync(["git", "-C", repo, "merge-tree", "--write-tree", "HEAD", branch], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode === 128) return undefined; // merge-tree unsupported / bad ref
		return r.exitCode !== 0 || r.stdout.toString().includes("CONFLICT");
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
			ahead = ab.ahead;
			behind = ab.behind;
			if (behind > 0 && ahead > 0 && (predictsConflict(m.repo, m.branch) ?? true)) readiness = "diverged";
			else if (changedFiles > 0) readiness = "uncommitted";
			else if (ahead > 0) readiness = "ahead";
			else readiness = "clean";
		}
		out.push({ agentId: m.agentId, agentName: m.agentName, branch: m.branch, worktree: m.worktree, changedFiles, ahead, behind, readiness });
	}
	return out;
}

const PLANE_RE = /\bPLANE:\s*([A-Z0-9]+-\d+)/g;

export interface PlanDirInfo {
	/** Repo-relative dir, e.g. "plans/auth". */
	dir: string;
	title: string;
	issueIds: string[];
}

/** Scan the repo's plans/ directory for plan dirs (each containing markdown), extracting any PLANE: pointers. */
export async function listPlanDirs(repo: string): Promise<PlanDirInfo[]> {
	const root = path.join(repo, "plans");
	let entries: string[];
	try {
		entries = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
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
		const issueIds = new Set<string>();
		for (const f of files) {
			const text = await fs.readFile(path.join(dirAbs, f), "utf8").catch(() => "");
			for (const m of text.matchAll(PLANE_RE)) issueIds.add(m[1]);
		}
		out.push({ dir: path.join("plans", name), title: name, issueIds: [...issueIds] });
	}
	return out;
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

/** One concern doc inside a plan dir (a `plans/<x>/NN-*.md` with a STATUS frontmatter line). */
export interface PlanConcern {
	file: string;
	title: string;
	status: string;
	priority?: string;
	complexity?: string;
	planeId?: string;
	open: boolean;
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
			title: C_TITLE.exec(text)?.[1] ?? f.replace(/\.md$/, ""),
			status,
			priority: C_PRIORITY.exec(text)?.[1]?.toLowerCase(),
			complexity: C_COMPLEXITY.exec(text)?.[1]?.toLowerCase(),
			planeId: C_PLANE_LINE.exec(text)?.[1],
			open: !CLOSED_STATUS.has(status),
		});
	}
	return out;
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

/** Build the feature list for one repo: persisted features (explicit membership) + unadopted plan dirs + unassigned agents. */
export async function buildFeatures(repo: string, agents: AgentDTO[], persisted: PersistedFeature[] = []): Promise<FeatureDTO[]> {
	const features: FeatureDTO[] = [];
	const assigned = new Set<string>();
	const adoptedDirs = new Set<string>();

	for (const pf of persisted) {
		if (pf.repo !== repo || pf.archived) continue;
		if (pf.origin?.planDir) adoptedDirs.add(pf.origin.planDir);
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
		features.push({
			id: pf.id,
			title: pf.title,
			repo,
			stage: pf.stageOverride ?? deriveStage({ agents: members, worktrees, unlanded: unlandedFiles, planDir: pf.origin?.planDir, hasIssues }),
			planDir: pf.origin?.planDir,
			agentIds: members.map((a) => a.id),
			worktrees,
			unlandedFiles,
			divergent: worktrees.some((w) => w.readiness === "diverged"),
			blocked: members.some((a) => a.status === "input"),
			statusCounts: countStatuses(members),
			issueIdentifiers: hasIssues ? issueIds : undefined,
			persisted: true,
			stageOverride: pf.stageOverride,
		});
	}

	for (const pd of await listPlanDirs(repo)) {
		if (adoptedDirs.has(pd.dir)) continue;
		features.push({
			id: `plan:${repo}:${pd.dir}`,
			title: pd.title,
			repo,
			stage: deriveStage({ agents: [], worktrees: [], unlanded: 0, planDir: pd.dir, hasIssues: pd.issueIds.length > 0 }),
			planDir: pd.dir,
			agentIds: [],
			worktrees: [],
			unlandedFiles: 0,
			divergent: false,
			blocked: false,
			statusCounts: {},
			issueIdentifiers: pd.issueIds.length > 0 ? pd.issueIds : undefined,
		});
	}

	for (const a of agents) {
		if (assigned.has(a.id)) continue;
		const worktrees = await featureLandStatus([{ agentId: a.id, agentName: a.name, branch: a.branch, worktree: a.worktree, repo }]);
		const unlandedFiles = worktrees.reduce((s, w) => s + w.changedFiles, 0);
		features.push({
			id: `agent:${a.id}`,
			title: a.name,
			repo,
			stage: deriveStage({ agents: [a], worktrees, unlanded: unlandedFiles, hasIssues: false }),
			agentIds: [a.id],
			worktrees,
			unlandedFiles,
			divergent: worktrees.some((w) => w.readiness === "diverged"),
			blocked: a.status === "input",
			statusCounts: countStatuses([a]),
			issueIdentifiers: a.issue?.identifier ? [a.issue.identifier] : undefined,
		});
	}

	return features;
}

/** Order branches for a Land-all: fast-forward-safe (ahead) first, then uncommitted; clean/diverged/no-branch excluded. */
export function landOrder(worktrees: FeatureWorktreeStatus[]): FeatureWorktreeStatus[] {
	const rank = (r: LandReadiness): number => (r === "ahead" ? 0 : r === "uncommitted" ? 1 : 2);
	return worktrees.filter((w) => w.readiness === "ahead" || w.readiness === "uncommitted").sort((a, b) => rank(a.readiness) - rank(b.readiness));
}
