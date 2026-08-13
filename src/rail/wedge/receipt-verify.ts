/**
 * The receipt-verification POLICY (glance#337, rail T9 gauntlet round 1 — CRITICAL, both lineages
 * converged 10/10): `postAgentPrCheck` used to green a required check on the mere TRUTHINESS of a
 * receipt object — no binding to the repo/commit it supposedly proves, no check that the land
 * actually succeeded, no freshness bound. A FAILED-land receipt, a green receipt for a DIFFERENT
 * repo/PR/commit, or a stale replayed one all turned the check green. This module is what makes
 * "glance receipt = success" mean "this exact SHA has a trustworthy, current land proof" instead of
 * "an object was passed."
 *
 * Four independent checks, ALL must pass for the receipt to be treated as proof:
 *   1. repo match   — `receipt.repo` names the SAME repo as the PR being checked (case-insensitive:
 *                      GitHub itself routes owner/repo case-insensitively, so this can't be defeated
 *                      by a casing mismatch, but a receipt for a DIFFERENT repo is rejected outright).
 *   2. SHA match     — the receipt certifies the PR's CURRENT head, never some other commit (a
 *                      different PR, an earlier push on the same PR, or a replayed/copied receipt
 *                      file). A real `receipt.commit` is REQUIRED (a landed receipt with none is
 *                      rejected outright — `headCommit` never substitutes for the landed commit); the
 *                      HEAD is then matched against `receipt.headCommit ?? receipt.commit` (glance#392 G8):
 *                      the wedge is a PRE-MERGE required check running on the PR's pre-merge head, but
 *                      a rail receipt's `commit` is the POST-merge merge commit — so it could NEVER
 *                      green pre-merge. A rail receipt now also carries `headCommit`, the exact
 *                      pre-merge tip the gate graded; when present it is the SHA that must equal the
 *                      PR head. An agent/post-merge receipt with no `headCommit` keeps the old
 *                      `commit`-match semantics untouched. Either way a receipt for the WRONG commit
 *                      still fails — the check is tightened for the pre-merge case, never loosened.
 *   3. gate outcome  — `receipt.landed === true`, `receipt.gate.status` is a PROVEN outcome
 *                      (`"green"` or `"red-baseline"` — see `GateStatus`'s own doc for why
 *                      red-baseline still counts: the CHANGE introduced no new failures, even though
 *                      main itself isn't green), and NOT `receipt.forcedWithoutProof`. A failed,
 *                      rejected, no-gate, or human-forced land must never green the check.
 *   4. freshness     — `receipt.at` is no older than `maxAgeMs` before "now" (default 24h) and not in
 *                      the future. An old receipt is not standing evidence forever — see
 *                      `wedge-install.md`'s note on why this composes with (not replaces) the
 *                      Ruleset's `strict_required_status_checks_policy` for base-drift staleness.
 *
 * A MALFORMED receipt never reaches this function at all — decode it through `LandReceiptSchema`
 * (receipt-schema.ts) first; a decode failure is the caller's own fail-closed path.
 */
import type { GateStatus, LandReceipt } from "../receipt/types.ts";

export const DEFAULT_MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const PROVEN_GATE_STATUSES: ReadonlySet<GateStatus> = new Set(["green", "red-baseline"]);

export type ReceiptRejectReason = "repo-mismatch" | "sha-mismatch" | "gate-not-proven" | "stale";

export type ReceiptVerifyResult = { ok: true } | { ok: false; reason: ReceiptRejectReason; detail: string };

export interface ReceiptVerifyOptions {
	/** Overridable for tests; defaults to `Date.now()`. */
	now?: number;
	/** Defaults to `DEFAULT_MAX_RECEIPT_AGE_MS` (24h). */
	maxAgeMs?: number;
}

/** `owner`/`repo` identify the PR being checked (the wedge's own call target — NOT read from the
 *  receipt); `headSha` is the PR's CURRENT head, fetched fresh from GitHub for this check-run. */
export function verifyReceiptForPr(receipt: LandReceipt, owner: string, repo: string, headSha: string, opts: ReceiptVerifyOptions = {}): ReceiptVerifyResult {
	const expectedSlug = `${owner}/${repo}`.toLowerCase();
	const receiptSlug = receipt.repo.toLowerCase();
	if (receiptSlug !== expectedSlug) {
		return { ok: false, reason: "repo-mismatch", detail: `receipt is for "${receipt.repo}", this check is for "${owner}/${repo}"` };
	}

	// A landed receipt MUST identify the commit that landed — `headCommit` NEVER substitutes for that
	// (glance#392, codex gauntlet HIGH): `headCommit ?? commit` alone would green a receipt with
	// `commit:undefined, landed:true, headCommit === PR head` — a receipt asserting a land with no merge
	// commit, which the pre-B3 gate rejected as "nothing merged". Require a real `commit` first, THEN
	// match the PR head against the gated PRE-merge head (`headCommit`) when present — a rail receipt's
	// `commit` is the POST-merge merge commit, so a pre-merge check must match `headCommit`; an
	// agent/post-merge receipt with no `headCommit` keeps matching on `commit`. Either way, a receipt
	// with no landed commit can never verify.
	if (!receipt.commit) {
		return { ok: false, reason: "sha-mismatch", detail: "receipt has no landed commit (nothing merged)" };
	}
	const certifiedSha = (receipt.headCommit ?? receipt.commit).toLowerCase();
	const expectedSha = headSha.toLowerCase();
	if (certifiedSha !== expectedSha) {
		return {
			ok: false,
			reason: "sha-mismatch",
			detail: `receipt certifies ${receipt.headCommit ? "gated head" : "commit"} ${receipt.headCommit ?? receipt.commit}, but the PR's current head is ${headSha}`,
		};
	}

	if (!receipt.landed || receipt.forcedWithoutProof || !PROVEN_GATE_STATUSES.has(receipt.gate.status)) {
		const why = !receipt.landed
			? "the receipt records nothing merged"
			: receipt.forcedWithoutProof
				? "the land was FORCED without a passing proof"
				: `gate status "${receipt.gate.status}" is not a proven outcome`;
		return { ok: false, reason: "gate-not-proven", detail: why };
	}

	const now = opts.now ?? Date.now();
	const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_RECEIPT_AGE_MS;
	const ageMs = now - receipt.at;
	if (ageMs < 0 || ageMs > maxAgeMs) {
		const ageMinutes = Math.round(ageMs / 60_000);
		const maxMinutes = Math.round(maxAgeMs / 60_000);
		return {
			ok: false,
			reason: "stale",
			detail: ageMs < 0 ? `receipt is timestamped in the future (clock skew or a forged timestamp)` : `receipt is ${ageMinutes} minute(s) old, older than the ${maxMinutes}-minute freshness window`,
		};
	}

	return { ok: true };
}
