/**
 * TremendousProvider — real reward disbursement via the Tremendous REST API.
 *
 * Tremendous (https://www.tremendous.com) is a payouts API: one call sends a reward the recipient can
 * redeem as a gift card, PayPal cash, ACH, Visa card, etc. We use the Orders endpoint, which creates
 * an order containing one reward delivered by EMAIL to the recipient.
 *
 *   POST {base}/orders
 *   Authorization: Bearer <API key>
 *   {
 *     "external_id": "<idempotencyKey>",      // dedupe: same key => same order, never double-pay
 *     "payment": { "funding_source_id": "<FUNDING_SOURCE_ID>" },
 *     "rewards": [{
 *       "value":      { "denomination": <dollars>, "currency_code": "USD" },
 *       "campaign_id": "<CAMPAIGN_ID>",       // which redemption options the recipient sees
 *       "delivery":   { "method": "EMAIL" },
 *       "recipient":  { "name": "...", "email": "..." }
 *     }]
 *   }
 *
 * Idempotency: Tremendous treats `external_id` as the order's idempotency key — re-POSTing with the
 * same `external_id` returns the existing order (HTTP 200) instead of creating a second one. The
 * squad manager passes the reward id as the idempotency key, so a retried payout for one reward can
 * never create two orders.
 *
 * Failure handling: any non-2xx (or transport error) is mapped to `status:"failed"` with a readable
 * message. We never throw past `payout()` for an expected provider error, so a failed disbursement
 * leaves the reward un-paid rather than crashing the daemon.
 *
 * Env config (read by `tremendousFromEnv` / `paymentProviderFromEnv`):
 *   OMP_SQUAD_TREMENDOUS_API_KEY           — Bearer token (presence also selects this provider)
 *   OMP_SQUAD_TREMENDOUS_FUNDING_SOURCE_ID — which balance/account funds the payout
 *   OMP_SQUAD_TREMENDOUS_CAMPAIGN_ID       — redemption-options campaign the recipient sees
 *   OMP_SQUAD_TREMENDOUS_ENV               — "sandbox" (default) | "production"
 */

import type { PaymentProvider, PayoutRequest, PayoutResult } from "./types.ts";

export const TREMENDOUS_SANDBOX_BASE = "https://testflight.tremendous.com/api/v2";
export const TREMENDOUS_PRODUCTION_BASE = "https://api.tremendous.com/api/v2";

/** Minimal `fetch` shape so tests can inject a fake without DOM/Bun lib types. */
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
}>;

export interface TremendousProviderOptions {
	apiKey: string;
	fundingSourceId: string;
	campaignId: string;
	/** "sandbox" (default) or "production" — selects the API base URL. Ignored if `baseUrl` is set. */
	env?: "sandbox" | "production";
	/** Explicit base URL override (primarily for tests). */
	baseUrl?: string;
	/** Injectable fetch (defaults to global fetch) so tests never hit the network. */
	fetchImpl?: FetchLike;
}

export class TremendousProvider implements PaymentProvider {
	readonly name = "tremendous";
	private readonly apiKey: string;
	private readonly fundingSourceId: string;
	private readonly campaignId: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: FetchLike;

	constructor(opts: TremendousProviderOptions) {
		if (!opts.apiKey) throw new Error("TremendousProvider requires an API key");
		this.apiKey = opts.apiKey;
		this.fundingSourceId = opts.fundingSourceId;
		this.campaignId = opts.campaignId;
		this.baseUrl = opts.baseUrl ?? (opts.env === "production" ? TREMENDOUS_PRODUCTION_BASE : TREMENDOUS_SANDBOX_BASE);
		this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>);
	}

	async payout(req: PayoutRequest): Promise<PayoutResult> {
		// Validate config/recipient before spending a network call — surface as a payout failure,
		// not a thrown error, so the reward stays un-paid and the caller gets a clear message.
		const configError = this.configError(req);
		if (configError) return { status: "failed", externalRef: "", provider: this.name, error: configError };

		const body = JSON.stringify({
			external_id: req.idempotencyKey,
			payment: { funding_source_id: this.fundingSourceId },
			rewards: [
				{
					value: { denomination: centsToDenomination(req.amountCents), currency_code: req.currency },
					campaign_id: this.campaignId,
					delivery: { method: "EMAIL" },
					recipient: {
						name: req.recipientName?.trim() || req.recipientEmail,
						email: req.recipientEmail,
					},
					...(req.note ? { message: req.note } : {}),
				},
			],
		});

		let res: Awaited<ReturnType<FetchLike>>;
		let text: string;
		try {
			res = await this.fetchImpl(`${this.baseUrl}/orders`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body,
			});
			text = await res.text();
		} catch (err) {
			return { status: "failed", externalRef: "", provider: this.name, error: `tremendous request failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		const parsed = safeJson(text);
		if (!res.ok) {
			return { status: "failed", externalRef: "", provider: this.name, raw: parsed ?? text, error: tremendousError(res.status, parsed, text) };
		}

		const order = extractOrder(parsed);
		const reward = extractReward(order);
		const externalRef = (typeof order?.id === "string" && order.id) || (typeof reward?.id === "string" && reward.id) || "";
		if (!externalRef) {
			return { status: "failed", externalRef: "", provider: this.name, raw: parsed ?? text, error: "tremendous response missing order id" };
		}
		// Map Tremendous status into our coarse status. PENDING/PENDING_INTERNAL_PREFUND => "pending";
		// anything else 2xx (EXECUTED/CART/etc.) is treated as delivered/issued => "paid".
		const status = orderIsPending(order, reward) ? "pending" : "paid";
		return { status, externalRef, provider: this.name, raw: parsed ?? text };
	}

	private configError(req: PayoutRequest): string | undefined {
		if (!this.fundingSourceId) return "OMP_SQUAD_TREMENDOUS_FUNDING_SOURCE_ID is not configured";
		if (!this.campaignId) return "OMP_SQUAD_TREMENDOUS_CAMPAIGN_ID is not configured";
		if (!req.recipientEmail) return "recipientEmail is required for a Tremendous payout";
		if (!(req.amountCents > 0)) return "amountCents must be greater than zero";
		return undefined;
	}
}

/** Build a TremendousProvider from env, or undefined if no API key is set. */
export function tremendousFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): TremendousProvider | undefined {
	const apiKey = env.OMP_SQUAD_TREMENDOUS_API_KEY?.trim();
	if (!apiKey) return undefined;
	return new TremendousProvider({
		apiKey,
		fundingSourceId: env.OMP_SQUAD_TREMENDOUS_FUNDING_SOURCE_ID?.trim() ?? "",
		campaignId: env.OMP_SQUAD_TREMENDOUS_CAMPAIGN_ID?.trim() ?? "",
		env: env.OMP_SQUAD_TREMENDOUS_ENV?.trim() === "production" ? "production" : "sandbox",
		fetchImpl,
	});
}

/** Tremendous denominations are major units (dollars). Convert from cents without float drift. */
function centsToDenomination(cents: number): number {
	return Math.round(cents) / 100;
}

function safeJson(text: string): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function extractOrder(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!parsed) return undefined;
	const order = parsed.order;
	if (order && typeof order === "object") return order as Record<string, unknown>;
	// Some error/edge responses return the order fields at the top level.
	if (typeof parsed.id === "string") return parsed;
	return undefined;
}

function extractReward(order: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!order) return undefined;
	const rewards = order.rewards;
	if (Array.isArray(rewards) && rewards.length && rewards[0] && typeof rewards[0] === "object") {
		return rewards[0] as Record<string, unknown>;
	}
	return undefined;
}

function orderIsPending(order: Record<string, unknown> | undefined, reward: Record<string, unknown> | undefined): boolean {
	const status = String(order?.status ?? reward?.status ?? "").toUpperCase();
	return status.startsWith("PENDING");
}

function tremendousError(httpStatus: number, parsed: Record<string, unknown> | undefined, rawText: string): string {
	// Tremendous errors look like { "errors": { "message": "...", "payload": {...} } }.
	const errors = parsed?.errors;
	if (errors && typeof errors === "object") {
		const message = (errors as Record<string, unknown>).message;
		if (typeof message === "string" && message) return `tremendous ${httpStatus}: ${message}`;
	}
	const message = parsed?.message;
	if (typeof message === "string" && message) return `tremendous ${httpStatus}: ${message}`;
	return `tremendous ${httpStatus}: ${rawText.slice(0, 300) || "request failed"}`;
}
