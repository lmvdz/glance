/**
 * Concern 02 — VoiceAttentionSource: ladder ordering reused (without a fake AgentDTO), push
 * dedup/dismissal, and no repeated notification after a daemon restart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PushService, type PushSend, type PushSubscription } from "../src/push.ts";
import { activeVoiceDecisions, VoiceAttentionSource, voiceChannelLadderPriority, voiceDecisionLadderPriority, voiceDecisionPushPayload } from "../src/voice-attention.ts";
import type { JournalDecisionSnapshot } from "../src/voice-call-journal.ts";

function decision(overrides: Partial<JournalDecisionSnapshot> & { id: string; state: JournalDecisionSnapshot["state"] }): JournalDecisionSnapshot {
	return { prompt: "Which name?", options: [{ index: 0, label: "Keep it", consequence: "no-op" }], requiresConfirmation: false, createdAt: 1, updatedAt: 1, ...overrides };
}

async function makeSubscription(): Promise<PushSubscription> {
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const uaPublic = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
	return { endpoint: "https://push.example.com/x", keys: { p256dh: uaPublic.toString("base64url"), auth: auth.toString("base64url") } };
}

describe("ladder reuse (no fake AgentDTO)", () => {
	test("requiresConfirmation ranks as pending-approval, an ordinary open decision as awaiting-input", () => {
		expect(voiceDecisionLadderPriority(decision({ id: "d1", state: "awaiting-confirmation" }))).toBe("pending-approval");
		expect(voiceDecisionLadderPriority(decision({ id: "d1", state: "open" }))).toBe("awaiting-input");
	});

	test("a terminal decision carries no ladder priority", () => {
		for (const state of ["answered", "expired", "cancelled", "failed"] as const) {
			expect(voiceDecisionLadderPriority(decision({ id: "d1", state }))).toBeUndefined();
		}
	});

	test("channel roll-up picks the MOST urgent rung present, per the shared LADDER_RANK order", () => {
		const decisions = [decision({ id: "d1", state: "open" }), decision({ id: "d2", state: "awaiting-confirmation" })];
		expect(voiceChannelLadderPriority(decisions)).toBe("pending-approval");
	});

	test("an empty or fully-resolved set rolls up to idle", () => {
		expect(voiceChannelLadderPriority([])).toBe("idle");
		expect(voiceChannelLadderPriority([decision({ id: "d1", state: "answered" })])).toBe("idle");
	});

	test("activeVoiceDecisions filters to open/awaiting-confirmation only", () => {
		const decisions = [decision({ id: "d1", state: "open" }), decision({ id: "d2", state: "answered" }), decision({ id: "d3", state: "awaiting-confirmation" })];
		expect(activeVoiceDecisions(decisions).map((d) => d.id)).toEqual(["d1", "d3"]);
	});
});

describe("voiceDecisionPushPayload", () => {
	test("null for a terminal decision", () => {
		expect(voiceDecisionPushPayload("room-1", decision({ id: "d1", state: "answered" }))).toBeNull();
	});

	test("a tag that collapses on (channelId, decisionId)", () => {
		const payload = voiceDecisionPushPayload("room-1", decision({ id: "d1", state: "open" }));
		expect(payload?.tag).toBe("voice-decision:room-1:d1");
	});

	test("a deep link back to the room", () => {
		const payload = voiceDecisionPushPayload("room-1", decision({ id: "d1", state: "open" }));
		expect(payload?.url).toContain("room-1");
		expect(payload?.url).toContain("push=1");
	});
});

describe("VoiceAttentionSource push dedup/dismissal", () => {
	let dir: string;
	let sub: PushSubscription;
	beforeEach(async () => {
		dir = mkdtempSync(path.join(os.tmpdir(), "voice-attention-"));
		sub = await makeSubscription();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function pushService(): Promise<PushService> {
		const send: PushSend = async () => ({ status: 201 });
		const svc = new PushService(mkdtempSync(path.join(os.tmpdir(), "voice-attention-push-")), { send });
		await svc.init();
		await svc.subscribe(sub);
		return svc;
	}

	test("fires exactly one push per decision id", async () => {
		const svc = await pushService();
		const source = new VoiceAttentionSource(dir, { push: svc });
		const d = decision({ id: "d1", state: "open" });
		const first = await source.notifyIfDue("room-1", d);
		const second = await source.notifyIfDue("room-1", d);
		expect(first.sent).toBe(true);
		expect(second.sent).toBe(false);
		expect(second.reason).toBe("already-sent");
	});

	test("no push for a decision that never became active", async () => {
		const svc = await pushService();
		const source = new VoiceAttentionSource(dir, { push: svc });
		const result = await source.notifyIfDue("room-1", decision({ id: "d1", state: "answered" }));
		expect(result.sent).toBe(false);
		expect(result.reason).toBe("not-active");
	});

	test("no repeated notification after a daemon restart (dedup set is durable)", async () => {
		const svc1 = await pushService();
		const source1 = new VoiceAttentionSource(dir, { push: svc1 });
		const d = decision({ id: "d1", state: "open" });
		const first = await source1.notifyIfDue("room-1", d);
		expect(first.sent).toBe(true);

		// Simulate a restart: a fresh VoiceAttentionSource over the SAME stateDir.
		const svc2 = await pushService();
		const source2 = new VoiceAttentionSource(dir, { push: svc2 });
		const afterRestart = await source2.notifyIfDue("room-1", d);
		expect(afterRestart.sent).toBe(false);
		expect(afterRestart.reason).toBe("already-sent");
	});

	test("dismiss clears the dedup entry, allowing a genuinely later decision with the SAME id to push again", async () => {
		const svc = await pushService();
		const source = new VoiceAttentionSource(dir, { push: svc });
		const d = decision({ id: "d1", state: "open" });
		await source.notifyIfDue("room-1", d);
		expect(source.hasSent("room-1", "d1")).toBe(true);
		source.dismiss("room-1", "d1");
		expect(source.hasSent("room-1", "d1")).toBe(false);
		const again = await source.notifyIfDue("room-1", d);
		expect(again.sent).toBe(true);
	});

	test("with no push service wired, notifyIfDue reports no-push-service rather than throwing", async () => {
		const source = new VoiceAttentionSource(dir);
		const result = await source.notifyIfDue("room-1", decision({ id: "d1", state: "open" }));
		expect(result.sent).toBe(false);
		expect(result.reason).toBe("no-push-service");
	});
});
