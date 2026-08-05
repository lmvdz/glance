/**
 * The wedge's orchestrator (glance#337, rail T9): mint credentials → fetch the PR → verify any
 * supplied receipt → post the check-run. This is the single function the CLI
 * (scripts/post-wedge-check.ts) and, eventually, the daemon's own land path call — everything above
 * it (jwt/installation-token, pull-request, authorship, receipt-verify, receipt-adapter, check-run) is
 * a building block this composes.
 *
 * Gauntlet round 1 (glance#337 PR #358), two structural fixes from the original cut:
 *   - CRITICAL (both lineages): `conclusion = receipt ? "success" : ...` greened the check on the mere
 *     TRUTHINESS of a receipt object — no binding to the repo/commit it's proof for, no check that the
 *     land actually succeeded, no freshness bound. Every receipt now goes through
 *     `verifyReceiptForPr` (repo match, SHA match, proven gate outcome, freshness) before `success` is
 *     ever set; a receipt that fails any of those posts `failure` with the specific reason, never a
 *     silent pass.
 *   - HIGH / design (both lineages): a PR that doesn't classify as agent-authored is no longer
 *     SKIPPED (no check posted at all) — a Ruleset's required-status-check applies to every PR update
 *     to the protected branch, so posting nothing for human PRs would block them outright, and
 *     "post nothing ⇒ treat as passing" would recreate the exact evasion the check exists to prevent.
 *     Every PR now gets a check-run; a non-agent PR gets an honestly-labeled INFORMATIONAL `success`
 *     (`notRequiredOutput`) so the Ruleset stays coherent without silently gating ordinary human work.
 */

import { mintAppJwt } from "./jwt.ts";
import { mintInstallationToken } from "./installation-token.ts";
import { fetchPullRequest, type PullRequestInfo } from "./pull-request.ts";
import { classifyAgentAuthorship, DEFAULT_AUTHORSHIP_CONFIG, type AuthorshipConfig, type AuthorshipVerdict } from "./authorship.ts";
import { noReceiptOutput, notRequiredOutput, receiptRejectedOutput, receiptToCheckOutput } from "./receipt-adapter.ts";
import { verifyReceiptForPr, type ReceiptVerifyResult } from "./receipt-verify.ts";
import { findExistingCheckRun, upsertCheckRun, type CheckConclusion } from "./check-run.ts";
import type { WedgeApiOptions, WedgeCredentials } from "./types.ts";
import type { LandReceipt } from "../receipt/types.ts";

/** The Ruleset's `required_status_checks[].context` must match this string exactly (see the install
 *  runbook) — it's also what `findExistingCheckRun` filters on for the idempotent-update lookup. */
export const DEFAULT_CHECK_NAME = "glance/landing-rail-receipt";

export type CheckPostingReason =
	| "receipt-verified" // agent-authored PR, receipt supplied and verified — success
	| "receipt-rejected" // agent-authored PR, receipt supplied but failed verification — failure
	| "receipt-missing" // agent-authored PR, no receipt (or a malformed one) supplied — action_required
	| "human-not-required"; // not classified agent-authored — informational success, always posted

export interface PostWedgeCheckParams {
	credentials: WedgeCredentials;
	owner: string;
	repo: string;
	prNumber: number;
	/** A receipt to verify against this PR, if one was found for its head SHA. Absent ⇒ the
	 *  "no receipt" path — see `receiptError` for the "one was found but couldn't be read" variant. */
	receipt?: LandReceipt;
	/** Set by the caller when a receipt lookup found something but it couldn't be decoded (e.g. the
	 *  CLI's `--receipt` file failed `LandReceiptSchema` decode) — rendered as a distinct "malformed"
	 *  reason instead of the generic "no receipt found" message. Ignored when `receipt` is set. */
	receiptError?: string;
	authorshipConfig?: AuthorshipConfig;
	checkName?: string;
	detailsUrl?: string;
	apiOptions?: WedgeApiOptions;
	/** Overrides `verifyReceiptForPr`'s freshness window (default 24h — see receipt-verify.ts). */
	maxReceiptAgeMs?: number;
}

export interface PostWedgeCheckResult {
	pr: PullRequestInfo;
	authorship: AuthorshipVerdict;
	reason: CheckPostingReason;
	conclusion: CheckConclusion;
	/** Set only on `reason === "receipt-rejected"` — why the supplied receipt didn't verify. */
	rejection?: Extract<ReceiptVerifyResult, { ok: false }>;
	checkRunId: number;
	checkRunUrl: string;
}

/**
 * The end-to-end wedge flow for one PR:
 *   1. mint the App JWT, exchange it for an installation access token
 *   2. fetch the PR's author/branch/commit-trailer facts (including its CURRENT head SHA — always
 *      read fresh from GitHub, never trusted from the caller, so a receipt is verified against the
 *      real current state of the PR)
 *   3. run the agent-authorship gate to decide which verification path applies (never whether a check
 *      is posted at all — see this file's header)
 *   4. for an agent-authored PR: verify any supplied receipt (repo/SHA/gate-outcome/freshness) and
 *      post success/failure/action_required accordingly; for a non-agent PR: post an informational
 *      success so the Ruleset's required check stays satisfiable
 *   5. upsert (create-or-update) the check-run for the PR's CURRENT head SHA
 */
export async function postAgentPrCheck(params: PostWedgeCheckParams): Promise<PostWedgeCheckResult> {
	const opts = params.apiOptions ?? {};
	const appJwt = mintAppJwt(params.credentials.appId, params.credentials.privateKeyPem);
	const installationToken = await mintInstallationToken(appJwt, params.credentials.installationId, opts);

	const pr = await fetchPullRequest(installationToken.token, params.owner, params.repo, params.prNumber, opts);
	const authorship = classifyAgentAuthorship(pr, params.authorshipConfig ?? DEFAULT_AUTHORSHIP_CONFIG);

	let reason: CheckPostingReason;
	let conclusion: CheckConclusion;
	let output: ReturnType<typeof receiptToCheckOutput>;
	let rejection: Extract<ReceiptVerifyResult, { ok: false }> | undefined;

	if (!authorship.isAgentAuthored) {
		reason = "human-not-required";
		conclusion = "success";
		output = notRequiredOutput(pr, authorship);
	} else if (params.receipt) {
		const verify = verifyReceiptForPr(params.receipt, params.owner, params.repo, pr.headSha, { maxAgeMs: params.maxReceiptAgeMs });
		if (verify.ok) {
			reason = "receipt-verified";
			conclusion = "success";
			output = receiptToCheckOutput(params.receipt);
		} else {
			reason = "receipt-rejected";
			conclusion = "failure";
			rejection = verify;
			output = receiptRejectedOutput(params.receipt, verify, pr);
		}
	} else {
		reason = "receipt-missing";
		conclusion = "action_required";
		output = noReceiptOutput(pr, authorship, params.receiptError);
	}

	const checkName = params.checkName ?? DEFAULT_CHECK_NAME;
	const existingId = await findExistingCheckRun(installationToken.token, params.owner, params.repo, pr.headSha, checkName, Number(params.credentials.appId), opts);
	const posted = await upsertCheckRun(
		installationToken.token,
		{ owner: params.owner, repo: params.repo, name: checkName, headSha: pr.headSha, conclusion, output, detailsUrl: params.detailsUrl },
		existingId,
		opts,
	);

	return { pr, authorship, reason, conclusion, rejection, checkRunId: posted.id, checkRunUrl: posted.htmlUrl };
}
