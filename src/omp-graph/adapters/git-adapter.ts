/**
 * git adapter — a repo's commit history as omp-graph tracks.
 *
 * Emits three tracks (three of the five primitives):
 *   - events : notable commits (lands/feats/high-churn) as annotated marks
 *   - bars   : commits per hour
 *   - bars   : lines churned per hour (sqrt-scaled — big refactors crush linear)
 *
 * The parse + transform are pure and exported for tests; only `gitAdapter` does IO.
 */

import type { GraphGroup, GraphTrack, TimeRange } from "../schema.ts";
import { bucketSums, HOUR_MS, inRange } from "../schema.ts";
import type { AdapterContext, SourceAdapter } from "../adapter.ts";

export interface GitCommit {
	t: number;
	sha: string;
	subject: string;
	author: string;
	insertions: number;
	deletions: number;
	files: number;
}

export type CommitKind = "land" | "feat" | "fix" | "docs" | "other";

/** Classify a commit by its conventional-commit-ish subject → mark color/legend. */
export function classifyCommit(subject: string): CommitKind {
	const s = subject.toLowerCase();
	if (s.startsWith("squad") || s.includes("squad(")) return "land";
	if (s.startsWith("feat")) return "feat";
	if (s.startsWith("fix")) return "fix";
	if (s.startsWith("docs")) return "docs";
	return "other";
}

const MARK = "@@C@@";
/** The `git log --pretty` format the parser expects (sha, ISO author date, author, subject). */
export const GIT_LOG_FORMAT = `${MARK}\t%H\t%aI\t%an\t%s`;

/** Parse `git log --numstat` output (with GIT_LOG_FORMAT) into commits. Pure. */
export function parseGitLog(raw: string): GitCommit[] {
	const commits: GitCommit[] = [];
	let cur: GitCommit | null = null;
	for (const line of raw.split("\n")) {
		if (line.startsWith(MARK)) {
			const [, a = "", b = "", c = "", d = ""] = line.split("\t");
			const hasSha = !Number.isNaN(Date.parse(b));
			const sha = hasSha ? a : "";
			const iso = hasSha ? b : a;
			const author = hasSha ? c : b;
			const subject = hasSha ? d : c;
			const t = Date.parse(iso);
			if (Number.isNaN(t)) {
				cur = null;
				continue;
			}
			cur = { t, sha, subject, author, insertions: 0, deletions: 0, files: 0 };
			commits.push(cur);
		} else if (cur && line.trim()) {
			// numstat: "<ins>\t<del>\t<path>" — binary files show "-\t-\t<path>".
			const parts = line.split("\t");
			if (parts.length >= 3) {
				const ins = Number.parseInt(parts[0], 10);
				const del = Number.parseInt(parts[1], 10);
				cur.insertions += Number.isNaN(ins) ? 0 : ins;
				cur.deletions += Number.isNaN(del) ? 0 : del;
				cur.files += 1;
			}
		}
	}
	return commits;
}

/** Turn parsed commits into omp-graph tracks. Pure. */
export function commitTracks(commits: GitCommit[], range: TimeRange, group: string, source: string, limit = 40): GraphTrack[] {
	const inWindow = commits.filter((c) => inRange(c.t, range));

	// events: notable commits — lands/feats always, plus anything with real churn.
	const notable = inWindow
		.filter((c) => {
			const kind = classifyCommit(c.subject);
			return kind === "land" || kind === "feat" || c.insertions + c.deletions > 200;
		})
		.sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions))
		.slice(0, limit)
		.sort((a, b) => a.t - b.t);

	const events: GraphTrack = {
		id: "git.milestones",
		label: "MILESTONES",
		group,
		source,
		type: "events",
		marks: notable.map((c) => ({
			t: c.t,
			label: c.subject.slice(0, 72),
			kind: classifyCommit(c.subject),
			value: c.insertions + c.deletions,
			meta: { files: c.files, author: c.author, churn: c.insertions + c.deletions, sha: c.sha },
		})),
	};

	const commitsBars: GraphTrack = {
		id: "git.commits",
		label: "COMMITS",
		group,
		source,
		unit: "commits",
		type: "bars",
		binMs: HOUR_MS,
		scale: "linear",
		bins: bucketSums(range, HOUR_MS, inWindow.map((c) => ({ t: c.t, v: 1 }))),
	};

	const churnBars: GraphTrack = {
		id: "git.churn",
		label: "CHURN",
		group,
		source,
		unit: "lines",
		type: "bars",
		binMs: HOUR_MS,
		scale: "sqrt",
		bins: bucketSums(range, HOUR_MS, inWindow.map((c) => ({ t: c.t, v: c.insertions + c.deletions }))),
	};

	return [events, commitsBars, churnBars];
}

const GROUP: GraphGroup = { id: "fleet", label: "FLEET ACTIVITY", order: 0 };

/** Spawn `git log` for a repo/window and parse it. Returns "" for a non-repo. */
async function runGitLog(repo: string, range: TimeRange): Promise<string> {
	try {
		const proc = Bun.spawn(
			[
				"git",
				"-C",
				repo,
				"log",
				"--no-merges",
				`--since=${new Date(range.start).toISOString()}`,
				`--until=${new Date(range.end).toISOString()}`,
				`--pretty=format:${GIT_LOG_FORMAT}`,
				"--numstat",
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const raw = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return code === 0 ? raw : "";
	} catch {
		return "";
	}
}

export const gitAdapter: SourceAdapter = {
	id: "git",
	label: "Git",
	group: GROUP,
	async tracks(range, ctx: AdapterContext): Promise<GraphTrack[]> {
		if (!ctx.repo) return [];
		const raw = await runGitLog(ctx.repo, range);
		if (!raw.trim()) return [];
		return commitTracks(parseGitLog(raw), range, GROUP.id, "git", ctx.limit ?? 40);
	},
};
