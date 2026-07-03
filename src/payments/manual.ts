/**
 * ManualProvider — the records-only payout provider (no network).
 *
 * Preserves omp-squad's pre-Tremendous behavior: an operator who disbursed a reward out-of-band
 * (cut a check, sent a gift card by hand) records that fact by supplying a provider label + external
 * reference. There is no money movement here — it is a manual ledger entry, identical to what
 * `markFeedbackRewardPaid` did before the payments seam existed.
 *
 * It still goes through the `PaymentProvider` interface so the reward flow is uniform: the manager
 * always calls `provider.payout(...)`, and for the manual case the "external" handle is whatever the
 * operator typed. If no externalRef is supplied it falls back to the idempotency key so the result is
 * always a complete, persistable record.
 */

import type { PaymentProvider, PayoutRequest, PayoutResult } from "./types.ts";

export interface ManualProviderOptions {
	/** Provider label to stamp on the result/reward. Default "manual". */
	name?: string;
	/** Operator-supplied external reference (proof-of-payment handle) for the recorded payout. */
	externalRef?: string;
}

export class ManualProvider implements PaymentProvider {
	readonly name: string;
	private readonly externalRef?: string;

	constructor(opts: ManualProviderOptions = {}) {
		this.name = (opts.name ?? "manual").trim() || "manual";
		this.externalRef = opts.externalRef?.trim() || undefined;
	}

	async payout(req: PayoutRequest): Promise<PayoutResult> {
		// Records only — no funds move. Prefer the operator's externalRef; fall back to the
		// idempotency key so the recorded entry always has a stable, non-empty handle.
		const externalRef = this.externalRef ?? req.idempotencyKey;
		return {
			status: "paid",
			externalRef,
			provider: this.name,
			raw: { recorded: true, idempotencyKey: req.idempotencyKey, amountCents: req.amountCents, currency: req.currency },
		};
	}
}
