/**
 * The wedge's orchestrator (glance#337, rail T9): mint credentials → fetch the PR → gate on agent
 * authorship → post the check-run. This is the single function the CLI (scripts/post-wedge-check.ts)
 * and, eventually, the daemon's own land path call — everything above it (jwt/installation-token,
 * pull-request, authorship, receipt-adapter, check-run) is a building block this composes.
 */

import { mintAppJwt } from "./jwt.ts";
import { mintInstallationToken } from "./installation-token.ts";
import { fetchPullRequest, type PullRequestInfo } from "./pull-request.ts";
import { classifyAgentAuthorship, DEFAULT_AUTHORSHIP_CONFIG, type AuthorshipConfig, type AuthorshipVerdict } from "./authorship.ts";
import { noReceiptOutput, receiptToCheckOutput } from "./receipt-adapter.ts";
import { findExistingCheckRun, upsertCheckRun, type CheckConclusion } from "./check-run.ts";
import type { WedgeApiOptions, WedgeCredentials } from "./types.ts";
import type { LandReceipt } from "../receipt/types.ts";

/** The Ruleset's `required_status_checks[].context` must match this string exactly (see the install
 *  runbook) — it's also what `findExistingCheckRun` filters on for the idempotent-update lookup. */
export const DEFAULT_CHECK_NAME = "glance/landing-rail-receipt";

export interface PostWedgeCheckParams {
	credentials: WedgeCredentials;
	owner: string;
	repo: string;
	prNumber: number;
	/** Absent ⇒ the "no receipt found" gate path (`action_required`); present ⇒ the receipt is
	 *  rendered into the check-run and it posts `success`. The caller (daemon or CLI) decides which —
	 *  this function never reaches back into the land pipeline to look one up itself. */
	receipt?: LandReceipt;
	authorshipConfig?: AuthorshipConfig;
	checkName?: string;
	detailsUrl?: string;
	apiOptions?: WedgeApiOptions;
}

export type PostWedgeCheckResult =
	| { skipped: true; reason: "not-agent-authored"; pr: PullRequestInfo; authorship: AuthorshipVerdict }
	| { skipped: false; pr: PullRequestInfo; authorship: AuthorshipVerdict; conclusion: CheckConclusion; checkRunId: number; checkRunUrl: string };

/**
 * The end-to-end wedge flow for one PR:
 *   1. mint the App JWT, exchange it for an installation access token
 *   2. fetch the PR's author/branch/commit-trailer facts
 *   3. run the agent-authorship gate — a human-authored PR is skipped entirely (no check posted; the
 *      wedge only gates PRs it believes are agent-authored)
 *   4. build the check-run output — the T6 receipt if one was supplied, else the "no receipt found"
 *      explanation — and upsert (create-or-update) the check-run for the PR's CURRENT head SHA
 */
export async function postAgentPrCheck(params: PostWedgeCheckParams): Promise<PostWedgeCheckResult> {
	const opts = params.apiOptions ?? {};
	const appJwt = mintAppJwt(params.credentials.appId, params.credentials.privateKeyPem);
	const installationToken = await mintInstallationToken(appJwt, params.credentials.installationId, opts);

	const pr = await fetchPullRequest(installationToken.token, params.owner, params.repo, params.prNumber, opts);
	const authorship = classifyAgentAuthorship(pr, params.authorshipConfig ?? DEFAULT_AUTHORSHIP_CONFIG);
	if (!authorship.isAgentAuthored) {
		return { skipped: true, reason: "not-agent-authored", pr, authorship };
	}

	const output = params.receipt ? receiptToCheckOutput(params.receipt) : noReceiptOutput(pr, authorship);
	const conclusion: CheckConclusion = params.receipt ? "success" : "action_required";
	const checkName = params.checkName ?? DEFAULT_CHECK_NAME;

	const existingId = await findExistingCheckRun(installationToken.token, params.owner, params.repo, pr.headSha, checkName, Number(params.credentials.appId), opts);
	const posted = await upsertCheckRun(
		installationToken.token,
		{ owner: params.owner, repo: params.repo, name: checkName, headSha: pr.headSha, conclusion, output, detailsUrl: params.detailsUrl },
		existingId,
		opts,
	);

	return { skipped: false, pr, authorship, conclusion, checkRunId: posted.id, checkRunUrl: posted.htmlUrl };
}
