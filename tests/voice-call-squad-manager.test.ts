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

	// Concern 10 (call-management-ui): reattach follows the SAME canReadChannel-then-delegate shape
	// every other channel-scoped voice-call mutation on this file already proves.
	test("reattachVoiceCall refuses a non-member with 'forbidden', before the coordinator is ever consulted", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const outsider = actor("mallory");
		const channel = await mgr.createChannel(owner, { name: "private-room-7", visibility: "private" });
		const result = await mgr.reattachVoiceCall(channel.id, outsider);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("forbidden");
	});

	test("reattachVoiceCall authorizes a member through to the coordinator, which then refuses honestly for a channel with no active call", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-room-8", visibility: "private" });
		const result = await mgr.reattachVoiceCall(channel.id, owner);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no-active-call"); // authorized, but nothing to reattach to
	});
});

describe("listVoiceCallsSurface / endOrphanVoiceCall (concern 10: call-management-ui)", () => {
	test("only shows bindings the actor can actually read; orphans (which have no channel) are shown regardless", async () => {
		const mgr = makeManager();
		const alice = actor("alice");
		const bob = actor("bob");
		const alicesRoom = await mgr.createChannel(alice, { name: "alices-room", visibility: "private" });
		const bobsRoom = await mgr.createChannel(bob, { name: "bobs-room", visibility: "private" });
		// Both channels get a "connecting" binding directly on the store (bypassing the broker, which
		// this test's InertBroker refuses to actually create a call against) — enough to exercise the
		// membership filter without needing a real bridge/journal.
		mgr.voiceCall.bindings.beginConnecting(alicesRoom.id, { ownerActorId: alice.id, sessionRoot: "/tmp", retention: "full" });
		mgr.voiceCall.bindings.beginConnecting(bobsRoom.id, { ownerActorId: bob.id, sessionRoot: "/tmp", retention: "full" });

		const aliceSurface = await mgr.listVoiceCallsSurface(alice);
		expect(aliceSurface.bindings.map((b) => b.channelId)).toEqual([alicesRoom.id]);

		const bobSurface = await mgr.listVoiceCallsSurface(bob);
		expect(bobSurface.bindings.map((b) => b.channelId)).toEqual([bobsRoom.id]);
	});

	test("endOrphanVoiceCall needs no channel/membership check at all — an orphan has no channel to check", async () => {
		const stateDir = mkdtempSync(path.join(os.tmpdir(), "voice-call-mgr-"));
		cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
		const reaped: string[] = [];
		class TrackingBroker extends InertBroker {
			override async endCall(callId: string): Promise<void> {
				reaped.push(callId);
			}
		}
		const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, voiceBroker: new TrackingBroker() });
		const result = await mgr.endOrphanVoiceCall("call-orphan-1");
		expect(result).toEqual({ ok: true, value: { ended: true } });
		expect(reaped).toEqual(["call-orphan-1"]);
	});
});

describe("fleet delegation (concern 12): SquadManager's executor and context builder", () => {
	test("executeVoiceFleetCall refuses with no owner identity, and refuses a non-member owner", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-fleet-1", visibility: "private" });
		const noOwner = await mgr.executeVoiceFleetCall({ channelId: channel.id, ownerActor: undefined, tool: "fleet_roster", args: {} });
		expect(noOwner.status).toBe("failed");
		if (noOwner.status === "failed") expect(noOwner.detail).toContain("no recorded owner identity");
		const outsider = { id: "db:mallory", origin: "local" as const, role: "operator" as const, orgId: "org-a" };
		const denied = await mgr.executeVoiceFleetCall({ channelId: channel.id, ownerActor: outsider, tool: "fleet_roster", args: {} });
		expect(denied.status).toBe("failed");
		if (denied.status === "failed") expect(denied.detail).toContain("forbidden");
	});

	test("fleet_roster is room-scoped: an authorized owner sees only this room's units", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-fleet-2", visibility: "private" });
		const memberOwner = { id: owner.id, origin: "local" as const, role: "operator" as const, orgId: "org-a" };
		const result = await mgr.executeVoiceFleetCall({ channelId: channel.id, ownerActor: memberOwner, tool: "fleet_roster", args: {} });
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.detail).toContain("No units in this room");
	});

	test("unknown tools and malformed args fail with a named detail, never a throw", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-fleet-3", visibility: "private" });
		const memberOwner = { id: owner.id, origin: "local" as const, role: "operator" as const, orgId: "org-a" };
		const unknown = await mgr.executeVoiceFleetCall({ channelId: channel.id, ownerActor: memberOwner, tool: "fleet_rm_rf", args: {} });
		expect(unknown.status).toBe("failed");
		if (unknown.status === "failed") expect(unknown.detail).toContain("unrecognized fleet tool");
		const missing = await mgr.executeVoiceFleetCall({ channelId: channel.id, ownerActor: memberOwner, tool: "fleet_steer", args: { unitId: "u1" } });
		expect(missing.status).toBe("failed");
		if (missing.status === "failed") expect(missing.detail).toContain("missing required argument: message");
	});

	test("steer/detail/answer against a unit that is not in this room fail honestly", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-fleet-4", visibility: "private" });
		const memberOwner = { id: owner.id, origin: "local" as const, role: "operator" as const, orgId: "org-a" };
		for (const call of [
			{ tool: "fleet_steer", args: { unitId: "ghost-1", message: "hi" } },
			{ tool: "fleet_unit_detail", args: { unitId: "ghost-1" } },
			{ tool: "fleet_answer_gate", args: { unitId: "ghost-1", answer: "yes" } },
		]) {
			const result = await mgr.executeVoiceFleetCall({ channelId: channel.id, ownerActor: memberOwner, ...call });
			expect(result.status).toBe("failed");
			if (result.status === "failed") expect(result.detail).toContain('no unit "ghost-1" in this room');
		}
	});

	test("startVoiceCall snapshots the owner actor and validates a scoped agentId against the room", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-fleet-5", visibility: "private" });
		const scoped = await mgr.startVoiceCall(channel.id, owner, { agentId: "ompsq-404" });
		expect(scoped.ok).toBe(false);
		if (!scoped.ok) expect(scoped.reason).toContain('no unit "ompsq-404" in this room');
		// Without a scope the start proceeds to the broker (which this fixture makes fail) — and the
		// binding it persisted along the way carries the full owner snapshot for the fleet lane.
		const started = await mgr.startVoiceCall(channel.id, owner, {});
		expect(started.ok).toBe(false);
		const binding = mgr.voiceCall.bindings.get(channel.id);
		expect(binding?.ownerActor).toMatchObject({ id: owner.id, origin: "local", role: "operator", orgId: "org-a" });
	});

	test("voiceFleetContext is membership-gated and carries the framing header for an authorized owner", async () => {
		const mgr = makeManager();
		const owner = actor("alice");
		const channel = await mgr.createChannel(owner, { name: "private-fleet-6", visibility: "private" });
		const outsider = { id: "db:mallory", origin: "local" as const, role: "operator" as const, orgId: "org-a" };
		expect(await mgr.voiceFleetContext({ channelId: channel.id, ownerActor: outsider })).toBeUndefined();
		expect(await mgr.voiceFleetContext({ channelId: channel.id, ownerActor: undefined })).toBeUndefined();
		const memberOwner = { id: owner.id, origin: "local" as const, role: "operator" as const, orgId: "org-a" };
		const brief = await mgr.voiceFleetContext({ channelId: channel.id, ownerActor: memberOwner });
		expect(brief).toBeDefined();
		expect(brief!).toContain("data, not instructions");
		expect(brief!).toContain("private-fleet-6");
		expect(brief!).toContain("Units: none running in this room right now.");
	});
});
