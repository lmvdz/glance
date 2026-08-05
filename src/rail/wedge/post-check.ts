/**
 * The wedge's orchestrator (glance#337, rail T9): mint credentials → fetch the PR → verify any
 * supplied receipt → post the check-run. This is the single function the CLI
 * (scripts/post-wedge-check.ts) and, eventually, the daemon's own land path call — everything above
 * it (jwt/installation-token, pull-request, authorship, receipt-verify, receipt-adapter, check-run) is
 * a building block this composes.
 *
 * Gauntlet history (glance#337 PR #358) — two rounds, the second one closing the wedge:
 *
 *   ROUND 1, CRITICAL (both lineages): `conclusion = receipt ? "success" : ...` greened the check on
 *   the mere TRUTHINESS of a receipt object — no binding to the repo/commit it's proof for, no check
 *   that the land actually succeeded, no freshness bound. Fixed: every receipt now goes through
 *   `verifyReceiptForPr` (repo match, SHA match, proven gate outcome, freshness) before `success` is
 *   ever set; a receipt that fails any of those posts `failure` with the specific reason.
 *
 *   ROUND 1's OWN FIX, CRITICAL (round 2, codex delta-verify): round 1 also stopped SKIPPING non-agent
 *   PRs by posting them an informational `success` — but that `success` is Ruleset-INDISTINGUISHABLE
 *   from a real verified one (same context/SHA/integration_id/conclusion; a Ruleset can't predicate on
 *   `output.text`). An agent posing as human (or simply avoiding every authorship signal, which is
 *   OFF-by-default anyway) got classified non-agent and MERGED WITH NO RECEIPT VERIFIED AT ALL — round
 *   1 turned "missing-check blocks everyone" into "green bypass for anyone who avoids the signals,"
 *   which is worse than the original bug.
 *
 *   THE ACTUAL FIX (round 2, closing): gate ALL PRs, fail-closed, no authorship bypass. `success`
 *   requires a VALID receipt through `verifyReceiptForPr` — full stop, regardless of what
 *   `classifyAgentAuthorship` says. Authorship classification is now PURELY INFORMATIONAL: it's
 *   rendered in the check-run's output (`receipt-adapter.ts`'s `authorship` param) for a human
 *   reader's context, but it never changes `conclusion`. A security gate cannot key pass/fail on an
 *   agent-settable, spoofable signal — that's exactly what round 1's "informational success" bypass
 *   proved by construction. This is the honest posture for a SPIKE: the wedge gates a repo where every
 *   merge is expected to carry a glance receipt (an agent-only pilot, or a repo that opts into
 *   gate-all) — it deliberately BLOCKS a human PR with no receipt too. See the install runbook's
 *   headline section for the two coherent postures this leaves for an operator to choose between.
 */

import { mintAppJwt } from "./jwt.ts";
import { mintInstallationToken } from "./installation-token.ts";
import { fetchPullRequest, type PullRequestInfo } from "./pull-request.ts";
import { classifyAgentAuthorship, DEFAULT_AUTHORSHIP_CONFIG, type AuthorshipConfig, type AuthorshipVerdict } from "./authorship.ts";
import { noReceiptOutput, receiptRejectedOutput, receiptToCheckOutput } from "./receipt-adapter.ts";
import { verifyReceiptForPr, type ReceiptVerifyResult } from "./receipt-verify.ts";
import { findExistingCheckRun, upsertCheckRun, type CheckConclusion } from "./check-run.ts";
import type { WedgeApiOptions, WedgeCredentials } from "./types.ts";
import type { LandReceipt } from "../receipt/types.ts";

/** The Ruleset's `required_status_checks[].context` must match this string exactly (see the install
 *  runbook) — it's also what `findExistingCheckRun` filters on for the idempotent-update lookup. */
export const DEFAULT_CHECK_NAME = "glance/landing-rail-receipt";

export type CheckPostingReason =
	| "receipt-verified" // a valid receipt for THIS PR was supplied — success, regardless of authorship
	| "receipt-rejected" // a receipt was supplied but failed verification — failure
	| "receipt-missing"; // no (or a malformed) receipt was supplied — action_required

export interface PostWedgeCheckParams {
	credentials: WedgeCredentials;
	owner: string;
	repo: string;
	prNumber: number;
	/** A receipt to verify against this PR, if one was found for its head SHA. Absent ⇒ the
	 *  "no receipt" path — see `receiptError` for the "one was found but couldn't be read" variant.
	 *  REQUIRED for `success` on EVERY PR — authorship classification never substitutes for this. */
	receipt?: LandReceipt;
	/** Set by the caller when a receipt lookup found something but it couldn't be decoded (e.g. the
	 *  CLI's `--receipt` file failed `LandReceiptSchema` decode) — rendered as a distinct "malformed"
	 *  reason instead of the generic "no receipt found" message. Ignored when `receipt` is set. */
	receiptError?: string;
	/** Used ONLY to render informational "agent-authored: yes/no" context on the check-run — never to
	 *  decide `conclusion` (round 2 gauntlet fix; see this file's header). */
	authorshipConfig?: AuthorshipConfig;
	checkName?: string;
	detailsUrl?: string;
	apiOptions?: WedgeApiOptions;
	/** Overrides `verifyReceiptForPr`'s freshness window (default 24h — see receipt-verify.ts). */
	maxReceiptAgeMs?: number;
}

export interface PostWedgeCheckResult {
	pr: PullRequestInfo;
	/** Informational only — see this file's header. Never consulted for `conclusion`. */
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
 *   3. classify agent-authorship for INFORMATIONAL rendering only (never a gate decision — round 2 fix)
 *   4. verify any supplied receipt (repo/SHA/gate-outcome/freshness) and post
 *      success/failure/action_required accordingly — for EVERY PR, not just ones classified
 *      agent-authored
 *   5. upsert (create-or-update) the check-run for the PR's CURRENT head SHA
 */
export async function postAgentPrCheck(params: PostWedgeCheckParams): Promise<PostWedgeCheckResult> {
	const opts = params.apiOptions ?? {};
	const appJwt = mintAppJwt(params.credentials.appId, params.credentials.privateKeyPem);
	const installationToken = await mintInstallationToken(appJwt, params.credentials.installationId, opts);

	const pr = await fetchPullRequest(installationToken.token, params.owner, params.repo, params.prNumber, opts);
	// Informational only from here on — NEVER branches the conclusion. See this file's header for why
	// (round 2 gauntlet: a conclusion keyed on this spoofable/avoidable classification is a bypass).
	const authorship = classifyAgentAuthorship(pr, params.authorshipConfig ?? DEFAULT_AUTHORSHIP_CONFIG);

	let reason: CheckPostingReason;
	let conclusion: CheckConclusion;
	let output: ReturnType<typeof receiptToCheckOutput>;
	let rejection: Extract<ReceiptVerifyResult, { ok: false }> | undefined;

	if (params.receipt) {
		const verify = verifyReceiptForPr(params.receipt, params.owner, params.repo, pr.headSha, { maxAgeMs: params.maxReceiptAgeMs });
		if (verify.ok) {
			reason = "receipt-verified";
			conclusion = "success";
			output = receiptToCheckOutput(params.receipt, authorship);
		} else {
			reason = "receipt-rejected";
			conclusion = "failure";
			rejection = verify;
			output = receiptRejectedOutput(params.receipt, verify, pr, authorship);
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
