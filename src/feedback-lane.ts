/**
 * The feedback lane — campaigns, submissions, validations, rewards, and payout — extracted from
 * SquadManager (concern 04 of plans/deepen-modules, first island). The scan verified this cluster
 * never touches `agents` or any fleet state: its whole world is the feedback snapshot
 * (store.loadFeedback/saveFeedback), the stateDir attachment tree, the payment provider, and the
 * audit trail. That world is now the `FeedbackLaneDeps` port; SquadManager is the production
 * adapter (its Store, its stateDir, its provider, its recordFeedbackAudit) and keeps thin
 * delegations so no caller — feedback-routes.ts, server.ts, tests — changes.
 *
 * Deps are thunks/closures, not captured values: SquadManager constructs this lane as a field
 * initializer, BEFORE its constructor assigns `store`/`paymentProvider` — a captured value would
 * freeze `undefined` (the same init-order contract DecisionLedger's adapter documents).
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	acceptFeedbackSubmission,
	assertRewardTransition,
	hashCampaignToken,
	newCampaignId,
	normalizeFeedbackValidation,
	renderFeedbackPlaneIssue,
	summarizeFeedback,
	type FeedbackSnapshot,
	type FeedbackSummary,
	type FeedbackValidationInput,
} from "./feedback.ts";
import { LOCAL_ACTOR } from "./federation.ts";
import { ManualProvider, type PaymentProvider } from "./payments/index.ts";
import { createPlaneIssue } from "./plane.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import type { Actor, FeedbackCampaign, FeedbackItem, FeedbackReward, FeedbackValidationResponse } from "./types.ts";

export interface FeedbackLaneDeps {
	loadFeedback(): Promise<FeedbackSnapshot>;
	saveFeedback(snapshot: FeedbackSnapshot): Promise<void>;
	/** Root for the `feedback/attachments/…` tree. */
	stateDir(): string;
	/** Reward disbursement seam — Tremendous when configured, ManualProvider otherwise. */
	paymentProvider(): PaymentProvider;
	/** Operator-visible audit + durable audit row (SquadManager.recordFeedbackAudit's contract). */
	audit(actor: Actor, action: string, target: string, detail?: string): Promise<void>;
}

function feedbackMaxImageBytes(): number {
	const n = Number(process.env.OMP_SQUAD_FEEDBACK_MAX_IMAGE_BYTES);
	return Number.isFinite(n) && n > 0 ? n : 2_000_000;
}

function feedbackItemOrThrow(items: FeedbackItem[], id: string): FeedbackItem {
	const item = items.find((x) => x.id === id);
	if (!item) throw new Error("feedback item not found");
	return item;
}

function rewardRecordOrThrow(snap: FeedbackSnapshot, id: string): { item: FeedbackItem; reward: FeedbackReward } {
	const item = feedbackItemOrThrow(snap.items, id);
	const reward = snap.rewards.find((r) => r.feedbackId === id);
	if (!reward || item.rewardStatus === "none") throw new Error("feedback item has no reward");
	return { item, reward };
}

export class FeedbackLane {
	constructor(private readonly deps: FeedbackLaneDeps) {}

	async listCampaigns(): Promise<FeedbackCampaign[]> {
		return (await this.deps.loadFeedback()).campaigns;
	}

	async listItems(): Promise<{ items: FeedbackSummary[]; raw: FeedbackItem[]; validations: FeedbackValidationResponse[]; rewards: FeedbackReward[] }> {
		const snap = await this.deps.loadFeedback();
		return {
			items: snap.items.map((item) => summarizeFeedback(item, snap.validations, snap.rewards.find((r) => r.feedbackId === item.id))),
			raw: snap.items,
			validations: snap.validations,
			rewards: snap.rewards,
		};
	}

	async seedCampaign(opts: { id?: string; name: string; repo: string; token: string; allowedOrigins?: string[]; rewardCents?: number; rewardCurrency?: string }): Promise<FeedbackCampaign> {
		const snap = await this.deps.loadFeedback();
		const now = Date.now();
		const id = opts.id?.trim() || newCampaignId();
		const campaign: FeedbackCampaign = {
			id,
			name: opts.name.trim() || "Feedback campaign",
			repo: normalizeRepoPath(opts.repo) || process.cwd(),
			tokenHash: hashCampaignToken(opts.token),
			allowedOrigins: opts.allowedOrigins?.length ? opts.allowedOrigins : ["*"],
			rewardCents: opts.rewardCents,
			rewardCurrency: opts.rewardCurrency,
			createdAt: snap.campaigns.find((c) => c.id === id)?.createdAt ?? now,
		};
		const i = snap.campaigns.findIndex((c) => c.id === id);
		if (i >= 0) snap.campaigns[i] = campaign;
		else snap.campaigns.push(campaign);
		await this.deps.saveFeedback(snap);
		return campaign;
	}

	async submitItem(body: unknown, origin?: string | null, now = Date.now()): Promise<FeedbackItem> {
		const snap = await this.deps.loadFeedback();
		const accepted = acceptFeedbackSubmission({ campaigns: snap.campaigns, body, origin, now, maxImageBytes: feedbackMaxImageBytes() });
		if (accepted.attachmentBytes && accepted.item.attachment && accepted.attachmentExt) {
			const rel = path.join("feedback", "attachments", accepted.item.id, `${accepted.item.attachment.id}.${accepted.attachmentExt}`);
			const full = path.join(this.deps.stateDir(), rel);
			await fs.mkdir(path.dirname(full), { recursive: true });
			const tmp = `${full}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			await fs.writeFile(tmp, accepted.attachmentBytes);
			await fs.rename(tmp, full);
			accepted.item.attachment = { ...accepted.item.attachment, path: rel };
		}
		snap.items.push(accepted.item);
		if (accepted.reward) snap.rewards.push(accepted.reward);
		await this.deps.saveFeedback(snap);
		return accepted.item;
	}

	async accept(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackItem> {
		const snap = await this.deps.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		if (item.status === "rejected") throw new Error("rejected feedback cannot be accepted");
		if (item.status !== "promoted") item.status = "accepted";
		item.updatedAt = Date.now();
		await this.deps.saveFeedback(snap);
		await this.deps.audit(actor, "feedback.accept", id);
		return item;
	}

	async reject(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackItem> {
		const snap = await this.deps.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		if (item.status === "promoted") throw new Error("promoted feedback cannot be rejected");
		item.status = "rejected";
		item.updatedAt = Date.now();
		await this.deps.saveFeedback(snap);
		await this.deps.audit(actor, "feedback.reject", id);
		return item;
	}

	async promote(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackItem> {
		const snap = await this.deps.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		if (item.planeIssue) return item;
		if (item.status === "rejected") throw new Error("rejected feedback cannot be promoted");
		if (item.status !== "accepted" && item.status !== "needs-validation") throw new Error("feedback must be accepted or needs-validation before promotion");
		const rendered = renderFeedbackPlaneIssue(item, snap.validations.filter((v) => v.feedbackId === id), snap.rewards.find((r) => r.feedbackId === id));
		const issue = await createPlaneIssue(item.repo, rendered.title, rendered.descriptionHtml);
		if (!issue) throw new Error("plane issue create failed");
		item.planeIssue = issue;
		item.status = "promoted";
		item.updatedAt = Date.now();
		await this.deps.saveFeedback(snap);
		await this.deps.audit(actor, "feedback.promote", id, issue.identifier ?? issue.id);
		return item;
	}

	async addValidation(id: string, input: FeedbackValidationInput, actor: Actor = LOCAL_ACTOR): Promise<FeedbackValidationResponse> {
		const snap = await this.deps.loadFeedback();
		const item = feedbackItemOrThrow(snap.items, id);
		const validation = normalizeFeedbackValidation(input, item);
		snap.validations.push(validation);
		if (item.status === "new") {
			item.status = "needs-validation";
			item.updatedAt = Date.now();
		}
		await this.deps.saveFeedback(snap);
		await this.deps.audit(actor, "feedback.validation", id);
		return validation;
	}

	async listValidations(id: string): Promise<FeedbackValidationResponse[]> {
		const snap = await this.deps.loadFeedback();
		feedbackItemOrThrow(snap.items, id);
		return snap.validations.filter((v) => v.feedbackId === id);
	}

	async approveReward(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackReward> {
		const snap = await this.deps.loadFeedback();
		const { item, reward } = rewardRecordOrThrow(snap, id);
		assertRewardTransition(reward.status, "approved");
		reward.status = "approved";
		reward.reviewer = actor.id;
		reward.updatedAt = Date.now();
		item.rewardStatus = "approved";
		item.updatedAt = reward.updatedAt;
		await this.deps.saveFeedback(snap);
		await this.deps.audit(actor, "feedback.reward.approve", id);
		return reward;
	}

	async voidReward(id: string, actor: Actor = LOCAL_ACTOR): Promise<FeedbackReward> {
		const snap = await this.deps.loadFeedback();
		const { item, reward } = rewardRecordOrThrow(snap, id);
		assertRewardTransition(reward.status, "void");
		reward.status = "void";
		reward.reviewer = actor.id;
		reward.updatedAt = Date.now();
		item.rewardStatus = "void";
		item.updatedAt = reward.updatedAt;
		await this.deps.saveFeedback(snap);
		await this.deps.audit(actor, "feedback.reward.void", id);
		return reward;
	}

	/**
	 * Disburse an approved feedback reward through the configured payment provider, then persist the
	 * result. This is the real money-movement entry point (replaces the old "manual ledger only"):
	 *
	 *  - State-machine gate FIRST, before any mutation or network call: only approved → paid is legal.
	 *    assertRewardTransition rejects illegal sources (none/pending/void/paid → paid) so a reward can
	 *    never jump to paid unapproved — and so we never call the provider for an ineligible reward.
	 *  - Idempotency: the reward id is passed as the provider's idempotencyKey. Real providers thread it
	 *    into the upstream idempotency handle (Tremendous `external_id`), so a retried payout for one
	 *    reward can never disburse twice.
	 *  - Manual provider (no creds, or name "manual"): preserves today's behavior — the operator must
	 *    supply a non-empty `provider` label AND `externalRef` (the out-of-band proof-of-payment handle).
	 *    No funds move; it's a recorded ledger entry.
	 *  - Real provider (e.g. Tremendous): recipient email is taken from `opts.recipientEmail` or the
	 *    linked feedback item's userEmail; provider + externalRef are read from the RESULT, not the
	 *    operator. On status "paid"/"pending" we persist the result's externalRef and set the reward
	 *    status (pending is recorded as paid since the model has no pending reward state). On "failed"
	 *    we do NOT mark paid — the reward stays approved and we throw a clear error.
	 *  - A provider error is a value (status:"failed"), never an exception across the provider boundary,
	 *    so a payout failure cannot crash the daemon.
	 */
	async markRewardPaid(
		id: string,
		opts: { provider?: string; externalRef?: string; recipientEmail?: string; recipientName?: string; note?: string } = {},
		actor: Actor = LOCAL_ACTOR,
	): Promise<FeedbackReward> {
		const operatorProvider = typeof opts.provider === "string" ? opts.provider.trim() : "";
		const operatorRef = typeof opts.externalRef === "string" ? opts.externalRef.trim() : "";
		const configured = this.deps.paymentProvider();
		const isManual = configured.name === "manual";
		// Manual path keeps the original required-fields contract: an out-of-band payout is only a
		// trustworthy ledger entry if the operator names the provider AND the proof-of-payment handle.
		if (isManual) {
			if (!operatorProvider) throw new Error("provider is required to record a reward payout (e.g. the payment service used)");
			if (!operatorRef) throw new Error("externalRef is required to record a reward payout (the provider's payment/transaction reference)");
		}

		const snap = await this.deps.loadFeedback();
		const { item, reward } = rewardRecordOrThrow(snap, id);
		// State-machine gate FIRST, before any mutation or network call.
		assertRewardTransition(reward.status, "paid");

		// Recipient comes from the explicit opt or the linked feedback item. Real disbursement needs it.
		const recipientEmail = (opts.recipientEmail ?? item.userEmail ?? "").trim();
		const recipientName = opts.recipientName?.trim() || undefined;
		const note = opts.note?.trim() || `omp-squad feedback reward for ${item.id}`;
		if (!isManual && !recipientEmail) {
			throw new Error("recipientEmail is required to disburse this reward (set it on the request or capture userEmail on the feedback item)");
		}

		// For the manual path, seed a per-call ManualProvider with the operator's externalRef so the
		// recorded handle is exactly what the operator supplied; otherwise use the configured provider.
		const provider = isManual ? new ManualProvider({ name: operatorProvider, externalRef: operatorRef }) : configured;
		const result = await provider.payout({
			idempotencyKey: reward.id, // reward id == idempotency key: retries never double-pay
			amountCents: reward.amount,
			currency: reward.currency,
			recipientEmail,
			recipientName,
			note,
		});

		if (result.status === "failed") {
			// Do NOT mark paid. Reward stays approved. Surface a clear error to the caller.
			await this.deps.audit(actor, "feedback.reward.payout_failed", id, `payout via ${result.provider} failed: ${result.error ?? "unknown error"}`);
			throw new Error(`reward payout failed (${result.provider}): ${result.error ?? "unknown error"}`);
		}

		// status "paid" or "pending": persist the RESULT's provider + externalRef and mark the reward.
		// The reward model has no "pending" state, so a pending disbursement is recorded as paid (the
		// money/order has been accepted upstream) — the audit detail preserves the true provider status.
		reward.status = "paid";
		reward.provider = result.provider;
		reward.externalRef = result.externalRef;
		reward.reviewer = actor.id;
		reward.updatedAt = Date.now();
		item.rewardStatus = "paid";
		item.updatedAt = reward.updatedAt;
		await this.deps.saveFeedback(snap);
		const detail = isManual
			? `manual record of externally-executed payment via ${result.provider} (ref ${result.externalRef}); no funds moved by omp-squad`
			: `disbursed via ${result.provider} (ref ${result.externalRef}, status ${result.status}) to ${recipientEmail}`;
		await this.deps.audit(actor, "feedback.reward.paid", id, detail);
		return reward;
	}
}
