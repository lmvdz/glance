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

// ── in-code cross-lineage gauntlet panel (T5, glance#333) ──────────────────────────────────────────
export type { PanelVerdict, PanelReviewerVerdict, PanelReviewer, PanelReviewerSpec, PanelVerifyReviewer, ReviewPanelOpts } from "./panel.ts";
export {
	runReviewPanel,
	reviewPanelEnabled,
	panelMax,
	panelTimeoutMs,
	diffRiskTier,
	defaultPanelReviewers,
	defaultPanelVerifyReviewer,
	PANEL_INVARIANTS,
} from "./panel.ts";
