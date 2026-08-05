/**
 * Fetch the PR facts the agent-authorship gate (authorship.ts) needs (glance#337, rail T9): the
 * author's login, the head branch/SHA, and every commit-trailer-shaped line across the PR's commits
 * (to find a `Co-Authored-By:`-style trailer). Read via the installation token so the wedge never
 * depends on a host-level `gh` CLI auth session — the App's own `pull_requests: read` grant is the
 * only credential this needs (per R1's minimal-permission design).
 */

import { githubApiRequest } from "./github-api.ts";
import { CommitListResponseSchema, PullResponseSchema } from "./schemas.ts";
import type { WedgeApiOptions } from "./types.ts";

export interface PullRequestInfo {
	number: number;
	/** The PR author's GitHub login, or "" if GitHub reports no user (a deleted/ghost account). */
	authorLogin: string;
	headRef: string;
	headSha: string;
	baseRef: string;
	/** Every trimmed `Key: value`-shaped line across all commit messages in the PR — the raw material
	 *  the authorship gate scans for a trailer key match. Not limited to `Co-Authored-By`; the gate
	 *  decides which keys count (authorship.ts's `AuthorshipConfig.trailerKeys`). */
	commitTrailerLines: string[];
}

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s*\S/;

export async function fetchPullRequest(token: string, owner: string, repo: string, prNumber: number, opts: WedgeApiOptions = {}): Promise<PullRequestInfo> {
	const pr = await githubApiRequest("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`, token, PullResponseSchema, opts);
	const commits = await githubApiRequest("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`, token, CommitListResponseSchema, opts);
	const commitTrailerLines = commits
		.flatMap((c) => c.commit.message.split(/\r\n|\r|\n/))
		.map((l) => l.trim())
		.filter((l) => TRAILER_LINE.test(l));
	return {
		number: pr.number,
		authorLogin: pr.user?.login ?? "",
		headRef: pr.head.ref,
		headSha: pr.head.sha,
		baseRef: pr.base.ref,
		commitTrailerLines,
	};
}
