/**
 * provenance — the plan → agent → proof → land thread for one shipped ticket.
 *
 * Everything the drawer shows already exists on disk: the plan concern carries
 * the PLANE: pointer, receipts carry featureId/cost/model/harness, and the land
 * commit follows the `squad(<name>): land <branch>` convention. This module
 * stitches them into one document; the "drill IS the navigation" endpoint.
 *
 * The git lookup is injectable so tests run against fixture logs.
 */

import { listPlanDirs, parsePlanConcerns } from "../features.ts";
import { readAllReceipts } from "../receipts.ts";
import type { RunReceipt } from "../types.ts";

export interface ProvenanceRun {
	agentId: string;
	name: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	costUsd?: number;
	model?: string;
	harness?: string;
	status: string;
	toolCalls: number;
	branch?: string;
}

export interface ProvenanceDoc {
	ticket: string;
	concern?: { planDir: string; file: string; title: string; status: string };
	feature?: { id: string; title: string };
	runs: ProvenanceRun[];
	land?: { sha: string; subject: string; dateMs: number; author: string };
	generatedAt: number;
}

const US = "\x1f";

/** `git log` over recent history as parsed rows; injectable for tests. */
export type GitLogReader = (repo: string) => Promise<{ sha: string; author: string; dateMs: number; subject: string }[]>;

export const defaultGitLog: GitLogReader = async (repo) => {
	const proc = Bun.spawn(["git", "-C", repo, "log", "-n", "400", `--format=%H${US}%an${US}%aI${US}%s`], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const text = await new Response(proc.stdout).text();
	await proc.exited;
	return text
		.split("\n")
		.filter((l) => l.includes(US))
		.map((l) => {
			const [sha, author, iso, subject] = l.split(US);
			return { sha, author, dateMs: Date.parse(iso) || 0, subject };
		});
};

/** Pick the land commit for a ticket: subject mentions the ticket, or lands one of the run branches. Pure. */
export function findLandCommit(
	log: { sha: string; author: string; dateMs: number; subject: string }[],
	ticket: string,
	branches: string[],
): { sha: string; subject: string; dateMs: number; author: string } | undefined {
	const t = ticket.toLowerCase();
	const tails = branches.map((b) => b.split("/").pop()?.toLowerCase()).filter((x): x is string => !!x && x.length > 2);
	for (const c of log) {
		const s = c.subject.toLowerCase();
		const isLand = s.includes("land") && (s.startsWith("squad") || s.includes("squad("));
		if (!isLand) continue;
		if (s.includes(t) || tails.some((tail) => s.includes(tail))) return { sha: c.sha, subject: c.subject, dateMs: c.dateMs, author: c.author };
	}
	return undefined;
}

/** Receipts belonging to the ticket's thread: by featureId when known, else by branch mention. Pure. */
export function threadRuns(receipts: RunReceipt[], ticket: string, featureId?: string): ProvenanceRun[] {
	const t = ticket.toLowerCase();
	return receipts
		.filter((r) => (featureId ? r.featureId === featureId : false) || r.branch?.toLowerCase().includes(t) || r.name.toLowerCase().includes(t))
		.sort((a, b) => a.startedAt - b.startedAt)
		.slice(-20)
		.map((r) => ({
			agentId: r.agentId,
			name: r.name,
			startedAt: r.startedAt,
			endedAt: r.endedAt,
			durationMs: r.durationMs,
			costUsd: r.costUsd,
			model: r.model,
			harness: r.harness ?? "omp",
			status: r.status,
			toolCalls: r.toolCalls,
			branch: r.branch,
		}));
}

export async function buildProvenance(opts: {
	repo: string;
	stateDir: string;
	ticket: string;
	/** id/title/planDir/issueIdentifiers of known features — the ticket→featureId bridge. */
	features?: { id: string; title: string; planDir?: string; issueIdentifiers?: string[] }[];
	gitLog?: GitLogReader;
	now?: number;
}): Promise<ProvenanceDoc> {
	const { repo, stateDir, ticket } = opts;
	const doc: ProvenanceDoc = { ticket, runs: [], generatedAt: opts.now ?? Date.now() };

	// plan concern via the PLANE: pointer
	let planDir: string | undefined;
	try {
		const dirs = await listPlanDirs(repo);
		planDir = dirs.find((d) => d.issueIds.includes(ticket))?.dir;
		if (planDir) {
			const concern = (await parsePlanConcerns(repo, planDir)).find((c) => c.planeId === ticket);
			if (concern) doc.concern = { planDir, file: concern.file, title: concern.title, status: concern.status };
		}
	} catch {
		// a repo without plans/ still gets runs + land
	}

	const feature =
		opts.features?.find((f) => f.issueIdentifiers?.includes(ticket)) ??
		(planDir ? opts.features?.find((f) => f.planDir === planDir) : undefined);
	if (feature) doc.feature = { id: feature.id, title: feature.title };

	const receipts = await readAllReceipts(stateDir).catch(() => [] as RunReceipt[]);
	doc.runs = threadRuns(receipts, ticket, feature?.id);

	const log = await (opts.gitLog ?? defaultGitLog)(repo).catch(() => []);
	doc.land = findLandCommit(log, ticket, doc.runs.map((r) => r.branch).filter((b): b is string => !!b));

	return doc;
}
