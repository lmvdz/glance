import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import {
	ManualProvider,
	type PaymentProvider,
	type PayoutRequest,
	type PayoutResult,
	paymentProviderFromEnv,
	TremendousProvider,
	TREMENDOUS_PRODUCTION_BASE,
	TREMENDOUS_SANDBOX_BASE,
	tremendousFromEnv,
	type FetchLike,
} from "../src/payments/index.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void> | void> = [];
const TREMENDOUS_ENV = ["OMP_SQUAD_TREMENDOUS_API_KEY", "OMP_SQUAD_TREMENDOUS_FUNDING_SOURCE_ID", "OMP_SQUAD_TREMENDOUS_CAMPAIGN_ID", "OMP_SQUAD_TREMENDOUS_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of TREMENDOUS_ENV) savedEnv[k] = process.env[k];

afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	for (const k of TREMENDOUS_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

/** Records every payout call and returns a configurable result. */
class FakeProvider implements PaymentProvider {
	readonly name: string;
	readonly calls: PayoutRequest[] = [];
	private readonly next: (req: PayoutRequest) => PayoutResult;

	constructor(name: string, next: (req: PayoutRequest) => PayoutResult) {
		this.name = name;
		this.next = next;
	}

	async payout(req: PayoutRequest): Promise<PayoutResult> {
		this.calls.push(req);
		return this.next(req);
	}
}

async function seededManager(provider?: PaymentProvider): Promise<{ manager: SquadManager; rewardId: string; itemId: string; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-payments-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const manager = new SquadManager({ stateDir: dir, store: new FileStore(dir), paymentProvider: provider });
	await manager.seedFeedbackCampaign({ id: "camp", name: "Beta", repo: "/repo/product", token: "tok", allowedOrigins: ["*"], rewardCents: 750, rewardCurrency: "USD" });
	const item = await manager.submitFeedbackItem(
		{ campaignId: "camp", token: "tok", kind: "bug", title: "Checkout breaks", description: "Pay does nothing.", userEmail: "winner@example.com" },
		undefined,
	);
	await manager.acceptFeedback(item.id);
	const reward = await manager.approveFeedbackReward(item.id);
	return { manager, rewardId: item.id, itemId: item.id, dir };
}

// ── reward-flow wiring (injected fake provider, no network) ───────────────────

test("successful payout marks the reward paid and stores the result's provider + externalRef", async () => {
	const fake = new FakeProvider("tremendous", () => ({ status: "paid", externalRef: "ord_LIVE_123", provider: "tremendous" }));
	const { manager, rewardId } = await seededManager(fake);

	const reward = await manager.markFeedbackRewardPaid(rewardId);

	expect(reward.status).toBe("paid");
	expect(reward.externalRef).toBe("ord_LIVE_123");
	expect(reward.provider).toBe("tremendous");
	// The reward's amount/currency flowed into the payout request.
	expect(fake.calls).toHaveLength(1);
	expect(fake.calls[0]).toMatchObject({ amountCents: 750, currency: "USD", recipientEmail: "winner@example.com" });
});

test("the idempotencyKey passed to the provider equals the reward record id (not the feedback id)", async () => {
	const fake = new FakeProvider("tremendous", (req) => ({ status: "paid", externalRef: `ord_${req.idempotencyKey}`, provider: "tremendous" }));
	const { manager, rewardId: feedbackId } = await seededManager(fake);

	const reward = await rewardFor(manager, feedbackId);
	await manager.markFeedbackRewardPaid(feedbackId);

	// markFeedbackRewardPaid is keyed by feedback id, but the dedupe key is the stable reward record id.
	expect(reward.id).toMatch(/^fr_/);
	expect(fake.calls[0].idempotencyKey).toBe(reward.id);
});

test("a failed payout leaves the reward approved and surfaces the error", async () => {
	const fake = new FakeProvider("tremendous", () => ({ status: "failed", externalRef: "", provider: "tremendous", error: "insufficient funds" }));
	const { manager, rewardId } = await seededManager(fake);

	await expect(manager.markFeedbackRewardPaid(rewardId)).rejects.toThrow(/insufficient funds/);

	// Reward must NOT be marked paid — it stays approved with no externalRef.
	const reloaded = await rewardFor(manager, rewardId);
	expect(reloaded.status).toBe("approved");
	expect(reloaded.externalRef).toBeUndefined();
});

test("pending payout is recorded as paid with the result's externalRef", async () => {
	const fake = new FakeProvider("tremendous", () => ({ status: "pending", externalRef: "ord_PENDING_9", provider: "tremendous" }));
	const { manager, rewardId } = await seededManager(fake);

	const reward = await manager.markFeedbackRewardPaid(rewardId);

	expect(reward.status).toBe("paid");
	expect(reward.externalRef).toBe("ord_PENDING_9");
});

test("the state gate runs before the provider — an unapproved reward never calls payout", async () => {
	const fake = new FakeProvider("tremendous", () => ({ status: "paid", externalRef: "x", provider: "tremendous" }));
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-payments-gate-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const manager = new SquadManager({ stateDir: dir, store: new FileStore(dir), paymentProvider: fake });
	await manager.seedFeedbackCampaign({ id: "camp", name: "Beta", repo: "/repo/product", token: "tok", allowedOrigins: ["*"], rewardCents: 500, rewardCurrency: "USD" });
	const item = await manager.submitFeedbackItem({ campaignId: "camp", token: "tok", kind: "bug", title: "x", description: "y", userEmail: "a@b.com" }, undefined);
	// reward is still "pending" (never approved) — approved → paid is the only legal transition.
	await expect(manager.markFeedbackRewardPaid(item.id)).rejects.toThrow(/illegal reward transition/);
	expect(fake.calls).toHaveLength(0);
});

// ── ManualProvider path (no creds) preserves today's behavior ─────────────────

test("ManualProvider path records the operator-supplied provider + externalRef and requires both", async () => {
	const { manager, rewardId } = await seededManager(new ManualProvider());

	await expect(manager.markFeedbackRewardPaid(rewardId, {})).rejects.toThrow(/provider is required/);
	await expect(manager.markFeedbackRewardPaid(rewardId, { provider: "paypal" })).rejects.toThrow(/externalRef is required/);

	const reward = await manager.markFeedbackRewardPaid(rewardId, { provider: "paypal", externalRef: "PP-TX-42" });
	expect(reward.status).toBe("paid");
	expect(reward.provider).toBe("paypal");
	expect(reward.externalRef).toBe("PP-TX-42");
});

test("ManualProvider.payout returns paid with the operator externalRef and never touches the network", async () => {
	const provider = new ManualProvider({ name: "check", externalRef: "CHK-9" });
	const result = await provider.payout({ idempotencyKey: "fr_x", amountCents: 100, currency: "USD", recipientEmail: "a@b.com" });
	expect(result).toMatchObject({ status: "paid", provider: "check", externalRef: "CHK-9" });

	// With no operator ref it falls back to the idempotency key so the record is always complete.
	const fallback = await new ManualProvider().payout({ idempotencyKey: "fr_y", amountCents: 100, currency: "USD", recipientEmail: "a@b.com" });
	expect(fallback.externalRef).toBe("fr_y");
});

// ── paymentProviderFromEnv factory ────────────────────────────────────────────

test("paymentProviderFromEnv selects Tremendous when the API key is set, Manual otherwise", () => {
	expect(paymentProviderFromEnv({}).name).toBe("manual");
	expect(paymentProviderFromEnv({ OMP_SQUAD_TREMENDOUS_API_KEY: "sk_test_123" } as NodeJS.ProcessEnv).name).toBe("tremendous");
});

test("tremendousFromEnv returns undefined without a key and a provider with one", () => {
	expect(tremendousFromEnv({})).toBeUndefined();
	expect(tremendousFromEnv({ OMP_SQUAD_TREMENDOUS_API_KEY: "sk_test_123" } as NodeJS.ProcessEnv)).toBeInstanceOf(TremendousProvider);
});

// ── TremendousProvider request shaping (injected fake fetch, no network) ──────

test("TremendousProvider POSTs a correctly-shaped order and parses the response", async () => {
	let seenUrl = "";
	let seenInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
	const fakeFetch: FetchLike = async (url, init) => {
		seenUrl = url;
		seenInit = init;
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ order: { id: "ORD-77", status: "EXECUTED", rewards: [{ id: "RW-1" }] } }),
		};
	};
	const provider = new TremendousProvider({ apiKey: "sk_live_abc", fundingSourceId: "FS-1", campaignId: "CAMP-1", env: "sandbox", fetchImpl: fakeFetch });

	const result = await provider.payout({
		idempotencyKey: "fr_reward_1",
		amountCents: 1250,
		currency: "USD",
		recipientEmail: "winner@example.com",
		recipientName: "Pat Winner",
		note: "thanks for the bug report",
	});

	// URL + auth headers
	expect(seenUrl).toBe(`${TREMENDOUS_SANDBOX_BASE}/orders`);
	expect(seenInit?.method).toBe("POST");
	expect(seenInit?.headers?.Authorization).toBe("Bearer sk_live_abc");
	expect(seenInit?.headers?.["Content-Type"]).toBe("application/json");

	// Body: external_id == idempotencyKey, funding source, denomination in dollars, recipient + campaign
	const body = JSON.parse(seenInit?.body ?? "{}");
	expect(body.external_id).toBe("fr_reward_1");
	expect(body.payment.funding_source_id).toBe("FS-1");
	expect(body.rewards).toHaveLength(1);
	expect(body.rewards[0]).toMatchObject({
		value: { denomination: 12.5, currency_code: "USD" },
		campaign_id: "CAMP-1",
		delivery: { method: "EMAIL" },
		recipient: { name: "Pat Winner", email: "winner@example.com" },
		message: "thanks for the bug report",
	});

	// Response parsing → externalRef from the order id
	expect(result).toMatchObject({ status: "paid", externalRef: "ORD-77", provider: "tremendous" });
});

test("TremendousProvider uses the production base when env is production", async () => {
	let seenUrl = "";
	const fakeFetch: FetchLike = async (url) => {
		seenUrl = url;
		return { ok: true, status: 200, text: async () => JSON.stringify({ order: { id: "ORD-1", status: "EXECUTED" } }) };
	};
	const provider = new TremendousProvider({ apiKey: "k", fundingSourceId: "FS", campaignId: "C", env: "production", fetchImpl: fakeFetch });
	await provider.payout({ idempotencyKey: "fr_1", amountCents: 100, currency: "USD", recipientEmail: "a@b.com" });
	expect(seenUrl).toBe(`${TREMENDOUS_PRODUCTION_BASE}/orders`);
});

test("TremendousProvider maps a non-2xx response to status:failed with the error message (no throw)", async () => {
	const fakeFetch: FetchLike = async () => ({
		ok: false,
		status: 422,
		text: async () => JSON.stringify({ errors: { message: "Funding source has insufficient balance" } }),
	});
	const provider = new TremendousProvider({ apiKey: "k", fundingSourceId: "FS", campaignId: "C", fetchImpl: fakeFetch });

	const result = await provider.payout({ idempotencyKey: "fr_1", amountCents: 100, currency: "USD", recipientEmail: "a@b.com" });
	expect(result.status).toBe("failed");
	expect(result.externalRef).toBe("");
	expect(result.error).toContain("Funding source has insufficient balance");
});

test("TremendousProvider maps a transport error to status:failed (never throws past the boundary)", async () => {
	const fakeFetch: FetchLike = async () => {
		throw new Error("ECONNREFUSED");
	};
	const provider = new TremendousProvider({ apiKey: "k", fundingSourceId: "FS", campaignId: "C", fetchImpl: fakeFetch });
	const result = await provider.payout({ idempotencyKey: "fr_1", amountCents: 100, currency: "USD", recipientEmail: "a@b.com" });
	expect(result.status).toBe("failed");
	expect(result.error).toContain("ECONNREFUSED");
});

test("TremendousProvider returns status:pending for a PENDING order", async () => {
	const fakeFetch: FetchLike = async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ order: { id: "ORD-P", status: "PENDING_INTERNAL_PREFUND" } }),
	});
	const provider = new TremendousProvider({ apiKey: "k", fundingSourceId: "FS", campaignId: "C", fetchImpl: fakeFetch });
	const result = await provider.payout({ idempotencyKey: "fr_1", amountCents: 100, currency: "USD", recipientEmail: "a@b.com" });
	expect(result).toMatchObject({ status: "pending", externalRef: "ORD-P" });
});

test("TremendousProvider fails closed when recipient email is missing (no network call)", async () => {
	let called = false;
	const fakeFetch: FetchLike = async () => {
		called = true;
		return { ok: true, status: 200, text: async () => "{}" };
	};
	const provider = new TremendousProvider({ apiKey: "k", fundingSourceId: "FS", campaignId: "C", fetchImpl: fakeFetch });
	const result = await provider.payout({ idempotencyKey: "fr_1", amountCents: 100, currency: "USD", recipientEmail: "" });
	expect(result.status).toBe("failed");
	expect(result.error).toContain("recipientEmail");
	expect(called).toBe(false);
});

// ── small helper to read a reward back from the store ─────────────────────────

async function rewardFor(manager: SquadManager, feedbackId: string) {
	const { rewards } = await manager.listFeedbackItems();
	const reward = rewards.find((r) => r.feedbackId === feedbackId);
	if (!reward) throw new Error(`no reward for ${feedbackId}`);
	return reward;
}
