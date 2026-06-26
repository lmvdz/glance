import { expect, test } from "bun:test";
import type { Store } from "../src/dal/store.ts";
import { assertRewardTransition, emptyFeedbackSnapshot, scoreValidation, type FeedbackSnapshot } from "../src/feedback.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor, FeedbackValidationResponse, RunReceipt } from "../src/types.ts";

function response(vote: FeedbackValidationResponse["vote"], pain?: number): FeedbackValidationResponse {
	return { id: `${vote}-${pain ?? "x"}`, feedbackId: "fb", campaignId: "camp", repo: "/repo", respondent: "u", vote, pain, createdAt: 1 };
}

class MemoryStore implements Store {
	snap: FeedbackSnapshot = emptyFeedbackSnapshot();
	audit: { actor: string; action: string; target?: string; detail?: unknown }[] = [];
	async hasState(): Promise<boolean> { return false; }
	async load() { return { agents: [], transcripts: {}, features: [] }; }
	async save(): Promise<void> {}
	async loadFeedback(): Promise<FeedbackSnapshot> { return structuredClone(this.snap); }
	async saveFeedback(snapshot: FeedbackSnapshot): Promise<void> { this.snap = structuredClone(snapshot); }
	async appendAudit(entry: { actor: string; action: string; target?: string; detail?: unknown }): Promise<void> { this.audit.push(entry); }
	async appendUsage(_receipt: RunReceipt): Promise<void> {}
}

test("validation score handles none, weak, medium, and strong confidence", () => {
	expect(scoreValidation([])).toMatchObject({ yes: 0, no: 0, total: 0, confidence: "none" });
	expect(scoreValidation([response("valid", 4)])).toMatchObject({ yes: 1, no: 0, total: 1, averagePain: 4, confidence: "weak" });
	expect(scoreValidation([response("valid", 5), response("valid", 4), response("invalid", 2)])).toMatchObject({ yes: 2, no: 1, total: 3, confidence: "medium" });
	expect(scoreValidation([response("valid", 5), response("valid", 4), response("valid", 4), response("valid", 5), response("invalid", 2), response("unsure", 3)])).toMatchObject({ yes: 4, no: 1, unsure: 1, total: 6, confidence: "strong" });
});

test("reward state machine rejects illegal transitions", () => {
	expect(() => assertRewardTransition("none", "paid")).toThrow("illegal reward transition: none -> paid");
	expect(() => assertRewardTransition("void", "paid")).toThrow("illegal reward transition: void -> paid");
	expect(() => assertRewardTransition("paid", "void")).toThrow("illegal reward transition: paid -> void");
	expect(() => assertRewardTransition("pending", "approved")).not.toThrow();
	expect(() => assertRewardTransition("approved", "paid")).not.toThrow();
});

test("reward approval and paid markers update ledger and append audit entries", async () => {
	const store = new MemoryStore();
	const actor: Actor = { id: "operator", origin: "local", role: "operator" };
	const manager = new SquadManager({ store, stateDir: "/tmp/feedback-memory" });
	await manager.seedFeedbackCampaign({ id: "camp", name: "Rewards", repo: "/repo", token: "tok", allowedOrigins: ["*"], rewardCents: 750, rewardCurrency: "USD" });
	const item = await manager.submitFeedbackItem({ campaignId: "camp", token: "tok", kind: "feature", title: "Export CSV", description: "I need account exports." }, undefined);

	const approved = await manager.approveFeedbackReward(item.id, actor);
	const paid = await manager.markFeedbackRewardPaid(item.id, { provider: "manual", externalRef: "receipt-1" }, actor);

	expect(approved.status).toBe("approved");
	expect(paid.status).toBe("paid");
	expect(paid.provider).toBe("manual");
	expect(store.audit.map((a) => a.action)).toContain("feedback.reward.approve");
	expect(store.audit.map((a) => a.action)).toContain("feedback.reward.paid");
	await expect(manager.voidFeedbackReward(item.id, actor)).rejects.toThrow("illegal reward transition: paid -> void");
});
