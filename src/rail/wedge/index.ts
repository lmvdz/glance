/**
 * src/rail/wedge — the GitHub-App wedge (glance#337, rail T9). Internal barrel; the PUBLIC seam for
 * consumers OUTSIDE src/rail is src/rail/index.ts, which re-exports this (mirroring receipt/index.ts).
 */

export type { WedgeCredentials, WedgeApiOptions } from "./types.ts";
export { mintAppJwt } from "./jwt.ts";
export { WedgeApiError, githubApiRequest } from "./github-api.ts";
export {
	InstallationTokenResponseSchema,
	PullResponseSchema,
	CommitListResponseSchema,
	CheckRunListResponseSchema,
	CheckRunResponseSchema,
} from "./schemas.ts";
export { mintInstallationToken, type InstallationToken } from "./installation-token.ts";
export { fetchPullRequest, type PullRequestInfo } from "./pull-request.ts";
export { classifyAgentAuthorship, DEFAULT_AUTHORSHIP_CONFIG, type AuthorshipConfig, type AuthorshipSignal, type AuthorshipVerdict } from "./authorship.ts";
export { receiptToCheckOutput, noReceiptOutput, type CheckRunOutput } from "./receipt-adapter.ts";
export { findExistingCheckRun, upsertCheckRun, type CheckConclusion, type CheckRunParams, type UpsertedCheckRun } from "./check-run.ts";
export { postAgentPrCheck, DEFAULT_CHECK_NAME, type PostWedgeCheckParams, type PostWedgeCheckResult } from "./post-check.ts";
export { loadWedgeCredentialsFromEnv, loadAuthorshipConfigFromEnv } from "./config.ts";
