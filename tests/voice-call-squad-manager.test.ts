/**
 * Concern 02 — SquadManager's voice-call delegating methods: room membership gates every read and
 * mutation the SAME way `appendChannelPost`/`channelEntries` already do, and a denied actor is
 * refused BEFORE the coordinator ever touches the bridge.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor } from "../src/types.ts";
import type { BrokerCallCreated, BrokerCallView, BrokerClient } from "../src/voice-call-manager.ts";

const actor = (userId: string): Actor => ({ id: `db:${userId}`, displayName: userId, origin: "local", role: "operator", orgId: "org-a" });

class InertBroker implements BrokerClient {
	async createCall(): Promise<BrokerCallCreated> {
		throw new Error("no bridge configured for this test — start() is not expected to succeed");
	}
	async endCall(): Promise<void> {}
	async listCalls(): Promise<BrokerCallView[]> {
		return [];
	}
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function makeManager(): SquadManager {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "voice-call-mgr-"));
	cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
	return new SquadManager({ stateDir, skipGlobalJanitors: true, voiceBroker: new InertBroker() });
}

describe("room membership gates voice-call reads/mutations", () => {
	test("a non-member of a private channel is refused startVoiceCall with 'forbidden'", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const outsider = actor("mallory");
		const channel = await mgr.createChannel(owner, { name: "private-room", visibility: "private" });
		const result = await mgr.startVoiceCall(channel.id, outsider, {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("forbidden");
	});

	test("a member CAN start (and the failure that follows is the broker's, not an authorization denial)", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-room", visibility: "private" });
		const result = await mgr.startVoiceCall(channel.id, owner, {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).not.toBe("forbidden");
	});

	test("voiceCallState/decisions/transcript/artifacts all throw 'channel forbidden' for a non-member", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const outsider = actor("mallory");
		const channel = await mgr.createChannel(owner, { name: "private-room-2", visibility: "private" });
		await expect(mgr.voiceCallState(channel.id, outsider)).rejects.toThrow("channel forbidden");
		await expect(mgr.voiceCallDecisions(channel.id, outsider)).rejects.toThrow("channel forbidden");
		await expect(mgr.voiceCallTranscript(channel.id, outsider)).rejects.toThrow("channel forbidden");
		await expect(mgr.voiceCallArtifacts(channel.id, outsider)).rejects.toThrow("channel forbidden");
		await expect(mgr.voiceCallGaps(channel.id, outsider)).rejects.toThrow("channel forbidden");
	});

	test("voiceCallState returns undefined (never throws) for a member with no call ever started", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-room-3", visibility: "private" });
		expect(await mgr.voiceCallState(channel.id, owner)).toBeUndefined();
	});

	test("resolveVoiceCallDecision and steerVoiceCall refuse a non-member before touching any bridge", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const outsider = actor("mallory");
		const channel = await mgr.createChannel(owner, { name: "private-room-4", visibility: "private" });
		const resolve = await mgr.resolveVoiceCallDecision(channel.id, outsider, { decisionId: "d1", optionIndex: 0, label: "x" });
		expect(resolve.ok).toBe(false);
		if (!resolve.ok) expect(resolve.reason).toBe("forbidden");
		const steer = await mgr.steerVoiceCall(channel.id, outsider, "hello");
		expect(steer.ok).toBe(false);
		if (!steer.ok) expect(steer.reason).toBe("forbidden");
	});

	test("the org-public default channel is readable by anyone — no forbidden thrown", async () => {
		const mgr = makeManager();
		const anyone = actor("nobody-in-particular");
		await mgr.listChannels(anyone); // ensures the lazily-created #fleet default channel exists
		expect(await mgr.voiceCallState("fleet", anyone)).toBeUndefined();
	});

	// Concern 09 (browser-audio-transport): attachVoiceCallAudioSink/pushVoiceCallMicAudio go through
	// the SAME canReadChannel gate every other voice-call mutation does, before the coordinator ever
	// gets a chance to check `noLocalAudio`/bridge availability — a non-member must be refused
	// "forbidden" specifically, never "no-active-call"/"bridge-unavailable" (which would leak whether
	// a call even exists on a channel this actor cannot read).
	test("attachVoiceCallAudioSink and pushVoiceCallMicAudio refuse a non-member with 'forbidden', before touching any bridge", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const outsider = actor("mallory");
		const channel = await mgr.createChannel(owner, { name: "private-room-5", visibility: "private" });
		const attach = await mgr.attachVoiceCallAudioSink(channel.id, outsider, { sendOutputAudio: () => {} });
		expect(attach.ok).toBe(false);
		if (!attach.ok) expect(attach.reason).toBe("forbidden");
		const push = await mgr.pushVoiceCallMicAudio(channel.id, outsider, new Float32Array([0.1]));
		expect(push.ok).toBe(false);
		if (!push.ok) expect(push.reason).toBe("forbidden");
	});

	test("a member is authorized through to the coordinator, which then refuses honestly for a channel with no active call", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-room-6", visibility: "private" });
		const attach = await mgr.attachVoiceCallAudioSink(channel.id, owner, { sendOutputAudio: () => {} });
		expect(attach.ok).toBe(false);
		if (!attach.ok) expect(attach.reason).toBe("no-active-call"); // authorized, but nothing to attach to — not "forbidden"
	});
});
