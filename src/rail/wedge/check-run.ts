/**
 * Create/update the wedge's Checks API check-run (glance#337, rail T9) — the surface R1 recommended
 * over the legacy Status API and over a required-reviewer flow (spoof-proof via `integration_id` in
 * the Ruleset; see plans/landing-rail/research/github-app-wedge.md).
 *
 * Idempotent per (repo, head SHA, check name): `findExistingCheckRun` looks up whether THIS App
 * already posted a check with this name for this SHA and, if so, `upsertCheckRun` PATCHes it instead
 * of creating a duplicate — so a daemon re-run against the same commit updates the same check-run
 * rather than accumulating one per attempt. This does NOT solve stale-receipt invalidation on a NEW
 * push (a different head SHA needs its own check-run; there is deliberately no logic here to mark an
 * old SHA's check-run stale) — that's the webhook fast-follow, logged as fog in the PR body.
 */

import { githubApiRequest } from "./github-api.ts";
import { CheckRunListResponseSchema, CheckRunResponseSchema } from "./schemas.ts";
import type { WedgeApiOptions } from "./types.ts";
import type { CheckRunOutput } from "./receipt-adapter.ts";

/** Every conclusion the Checks API defines for a `completed` run. The wedge only ever emits
 *  `success` (receipt present) or `action_required` (agent-authored, no receipt) — the rest exist so
 *  callers/tests can express the full type honestly. */
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "stale";

export interface CheckRunParams {
	owner: string;
	repo: string;
	/** The required-check context this App's Ruleset entry pins via `integration_id` — must exactly
	 *  match the Ruleset's `required_status_checks[].context` (see the install runbook). */
	name: string;
	headSha: string;
	conclusion: CheckConclusion;
	output: CheckRunOutput;
	/** Optional deep link back to the daemon's own run record / receipt HTML, surfaced as the
	 *  check-run's "Details" link. */
	detailsUrl?: string;
}

/** Find this App's own check-run for `name` at `headSha`, if one already exists. Filtering by
 *  `app.id` matters: another App or a legacy status could coincidentally share the same `name`
 *  string, and PATCHing THAT run would be either a permissions error or (worse) silently overwriting
 *  a different integration's check — filtering to our own App ID is what makes the upsert safe. */
export async function findExistingCheckRun(
	token: string,
	owner: string,
	repo: string,
	headSha: string,
	name: string,
	appId: number,
	opts: WedgeApiOptions = {},
): Promise<number | undefined> {
	const res = await githubApiRequest(
		"GET",
		`/repos/${owner}/${repo}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
		token,
		CheckRunListResponseSchema,
		opts,
	);
	return res.check_runs.find((c) => c.name === name && c.app?.id === appId)?.id;
}

export interface UpsertedCheckRun {
	id: number;
	htmlUrl: string;
	conclusion: CheckConclusion;
}

/** POST a new check-run, or PATCH `existingId` when the caller already resolved one via
 *  `findExistingCheckRun`. Always posts a COMPLETED run (`status: "completed"`) — the wedge is
 *  daemon-triggered after verification already finished (R1: "webhooks optional for v1"), so there is
 *  no `queued`/`in_progress` phase to represent. */
export async function upsertCheckRun(token: string, params: CheckRunParams, existingId?: number, opts: WedgeApiOptions = {}): Promise<UpsertedCheckRun> {
	const body = {
		name: params.name,
		head_sha: params.headSha,
		status: "completed",
		conclusion: params.conclusion,
		completed_at: new Date().toISOString(),
		output: params.output,
		...(params.detailsUrl ? { details_url: params.detailsUrl } : {}),
	};
	const path = existingId ? `/repos/${params.owner}/${params.repo}/check-runs/${existingId}` : `/repos/${params.owner}/${params.repo}/check-runs`;
	const method = existingId ? "PATCH" : "POST";
	const res = await githubApiRequest(method, path, token, CheckRunResponseSchema, { ...opts, body });
	return { id: res.id, htmlUrl: res.html_url, conclusion: params.conclusion };
}
