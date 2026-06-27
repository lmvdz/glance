/**
 * Payment provider seam for real reward disbursement.
 *
 * A `PaymentProvider` turns an approved feedback reward into an actual money movement (gift card,
 * PayPal, ACH, Visa, …) behind a single `payout()` call. The squad manager owns the reward state
 * machine; the provider owns the network call. Keeping them separate means:
 *   - tests inject a fake provider (no network) to exercise the reward flow, and
 *   - a provider failure is a *value* (`status:"failed"`), never an exception that crashes the daemon.
 *
 * Money never moves twice for one reward because the caller passes the reward id as `idempotencyKey`,
 * and every real provider threads it into the upstream request's idempotency handle (Tremendous's
 * `external_id`). Re-running a payout for the same reward returns the original order instead of
 * creating a new one.
 */

export interface PayoutRequest {
	/** Stable, caller-owned dedupe key. The squad manager passes the reward id so retries never double-pay. */
	idempotencyKey: string;
	/** Amount to disburse, in minor units (cents) — matches FeedbackReward.amount. */
	amountCents: number;
	/** ISO-4217 currency, e.g. "USD". */
	currency: string;
	/** Where the money goes. Required for real disbursement (gift-card/PayPal email, etc.). */
	recipientEmail: string;
	/** Optional display name for the recipient. */
	recipientName?: string;
	/** Optional human note attached to the payout (shows in the provider dashboard / email). */
	note?: string;
}

export type PayoutStatus = "paid" | "pending" | "failed";

export interface PayoutResult {
	/**
	 * Outcome of the disbursement:
	 *   - "paid":    funds delivered / reward issued (terminal success).
	 *   - "pending": accepted by the provider but not yet delivered (async settlement / approval).
	 *   - "failed":  not disbursed; `error` explains why. The caller MUST NOT mark the reward paid.
	 */
	status: PayoutStatus;
	/** Provider-side reference (order id / reward id / transaction id). Empty string on failure. */
	externalRef: string;
	/** Stable provider identifier persisted on the reward (e.g. "manual", "tremendous"). */
	provider: string;
	/** Raw provider response for the audit trail / debugging (never relied on for control flow). */
	raw?: unknown;
	/** Human-readable failure reason when status === "failed". */
	error?: string;
}

export interface PaymentProvider {
	/** Stable identifier persisted on the reward (also the default `PayoutResult.provider`). */
	readonly name: string;
	/**
	 * Attempt to disburse one reward. MUST resolve (never reject) for an expected provider error
	 * (non-2xx, bad config, network blip) — surface it as `status:"failed"` with `error`. A thrown
	 * error past this boundary is treated as a programmer bug, not a payout failure.
	 */
	payout(req: PayoutRequest): Promise<PayoutResult>;
}
