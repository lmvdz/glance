/**
 * src/rail — the landing pipeline's public seam (T7 slice 1, glance#335; design lmvdz/glance#328).
 *
 * Barrel for src/rail internals consumed OUTSIDE this directory. Explicit named re-exports only —
 * never `export *`, which would silently drop a duplicate name instead of failing loudly.
 *
 * land-risk.ts has NO barrel export: its sole consumer (src/land.ts) deep-imports it directly and is
 * carried on tests/rail-boundary.test.ts's allowlist. Adding a second consumer means either barreling
 * it here or extending that allowlist in the same PR.
 */

export type { LandLedger, ForcedLand, ValidatorOverride } from "./land-ledger.ts";
export {
	readLandLedger,
	landFailureCount,
	recordLandOutcome,
	readForcedLands,
	recordForcedLand,
	readValidatorOverrides,
	recordValidatorOverride,
} from "./land-ledger.ts";

// The land-receipt surface (glance#334, rail T6) — the self-contained HTML a human approves per land,
// plus its compact PR comment. Renderers are pure; write/post live in receipt/write.ts.
export type { LandReceipt, LandReceiptGate, LandReceiptCost, GateStatus, PanelVerdict, CommentOptions } from "./receipt/index.ts";
export {
	renderReceiptHtml,
	renderReceiptComment,
	mdEsc,
	classifyLand,
	writeLandReceipt,
	postReceiptComment,
	landReceiptDir,
	landReceiptFilename,
} from "./receipt/index.ts";

// The GitHub-App wedge (glance#337, rail T9) — gates agent-authored PRs on an external repo with a
// glance receipt via the Checks API, zero adoption by that repo. Reuses the receipt renderer above as
// the check-run's output.text. See src/rail/wedge/index.ts for the internal module layout.
export type {
	WedgeCredentials,
	WedgeApiOptions,
	InstallationToken,
	PullRequestInfo,
	AuthorshipConfig,
	AuthorshipSignal,
	AuthorshipVerdict,
	CheckRunOutput,
	CheckConclusion,
	CheckRunParams,
	UpsertedCheckRun,
	PostWedgeCheckParams,
	PostWedgeCheckResult,
} from "./wedge/index.ts";
export {
	mintAppJwt,
	WedgeApiError,
	githubApiRequest,
	InstallationTokenResponseSchema,
	PullResponseSchema,
	CommitListResponseSchema,
	CheckRunListResponseSchema,
	CheckRunResponseSchema,
	mintInstallationToken,
	fetchPullRequest,
	classifyAgentAuthorship,
	DEFAULT_AUTHORSHIP_CONFIG,
	receiptToCheckOutput,
	noReceiptOutput,
	findExistingCheckRun,
	upsertCheckRun,
	postAgentPrCheck,
	DEFAULT_CHECK_NAME,
	loadWedgeCredentialsFromEnv,
	loadAuthorshipConfigFromEnv,
} from "./wedge/index.ts";
