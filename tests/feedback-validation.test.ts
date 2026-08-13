import { expect, test } from "bun:test";
import type { AuditEntry, ChannelSearchResult, Store } from "../src/dal/store.ts";
import type { Channel, ChannelEntry, ChannelMembership, ChannelReadCursor } from "../src/channels.ts";
import type { Node } from "../src/memory/nodes.ts";
import type { NodeRecord } from "../src/memory/node-records.ts";
import type { DelegationGrant } from "../src/delegation-boundary.ts";
import type { PlanProposal } from "../src/plan-proposals.ts";
import { normalizeCapabilitySnapshot, type CapabilitySnapshot } from "../src/capabilities/index.ts";
import { assertRewardTransition, emptyFeedbackSnapshot, scoreValidation, type FeedbackSnapshot } from "../src/feedback.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor, FeedbackValidationResponse, PersistedFeature, RunReceipt, TranscriptEntry } from "../src/types.ts";

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
	async loadFeatures(): Promise<PersistedFeature[]> { return []; }
	async saveFeatures(_features: PersistedFeature[]): Promise<void> {}
	async loadTranscripts(): Promise<Record<string, TranscriptEntry[]>> { return {}; }
	async saveTranscripts(_transcripts: Record<string, TranscriptEntry[]>): Promise<void> {}
	async loadCapabilities(): Promise<CapabilitySnapshot> { return normalizeCapabilitySnapshot(undefined); }
	async saveCapabilities(_snapshot: CapabilitySnapshot): Promise<void> {}
	async appendAudit(entry: AuditEntry): Promise<void> { this.audit.push(entry as { actor: string; action: string; target?: string; detail?: unknown }); }
	async appendUsage(_receipt: RunReceipt): Promise<void> {}
	async listChannels(): Promise<Channel[]> { return []; }
	async getChannel(_id: string): Promise<Channel | undefined> { return undefined; }
	async putChannel(_channel: Channel): Promise<void> {}
	async listNodes(): Promise<Node[]> { return []; }
	async getNode(_id: string): Promise<Node | undefined> { return undefined; }
	async putNode(_node: Node): Promise<void> {}
	async bindNodeChannel(_nodeId: string, _channelId: string): Promise<Node | undefined> { return undefined; }
	async listNodeRecords(_nodeId: string): Promise<NodeRecord[]> { return []; }
	async putNodeRecord(_record: NodeRecord): Promise<void> {}
	async deleteNodeRecords(_nodeId: string, _ids: readonly string[]): Promise<number> { return 0; }
	async listDelegationGrants(): Promise<DelegationGrant[]> { return []; }
	async putDelegationGrant(_grant: DelegationGrant): Promise<void> {}
	async listPlanProposals(): Promise<PlanProposal[]> { return []; }
	async putPlanProposal(_proposal: PlanProposal): Promise<void> {}
	async listChannelEntries(_channelId: string, _since?: number): Promise<ChannelEntry[]> { return []; }
	async searchChannelEntries(_q: string, _limit?: number, _offset?: number): Promise<ChannelSearchResult[]> { return []; }
	async appendChannelEntry(entry: Omit<ChannelEntry, "seq">): Promise<ChannelEntry> { return { ...entry, seq: 0 }; }
	async nextChannelSeq(_channelId: string): Promise<number> { return 0; }
	async listChannelMemberships(_channelId: string): Promise<ChannelMembership[]> { return []; }
	async putChannelMembership(_row: ChannelMembership): Promise<void> {}
	async getChannelReadCursor(_channelId: string, _userId: string): Promise<ChannelReadCursor | undefined> { return undefined; }
	async putChannelReadCursor(_row: ChannelReadCursor): Promise<void> {}
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
