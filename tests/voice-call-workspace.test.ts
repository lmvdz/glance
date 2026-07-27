/**
 * Concern 03 — the two daemon surfaces the room-native call workspace needs on top of concern 02:
 * reading ONE artifact's immutable snapshot (the room's Markdown viewer) and a visible, idempotent
 * mute relay for the call HUD.
 *
 * Same shape as `tests/voice-call-manager.test.ts`: a real Bun.serve WebSocket as the fake bridge, an
 * in-memory broker, real files on disk — no oh-my-pi, no broker process, no microphone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ARTIFACT_VIEW_MAX_BYTES, ArtifactSnapshotStore } from "../src/voice-call-artifacts.ts";
import type { BrokerCallCreated, BrokerCallView, BrokerClient, EmitCardInput } from "../src/voice-call-manager.ts";
import { VoiceCallCoordinator } from "../src/voice-call-manager.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function tmpDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 15): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	if (!predicate()) throw new Error("waitFor: condition never became true within timeout");
}

// -------------------------------------------------------------------------------------------------
// Reading one artifact's immutable snapshot
// -------------------------------------------------------------------------------------------------

describe("ArtifactSnapshotStore#read", () => {
	test("a ready artifact returns the snapshot's bytes, not the source's", async () => {
		const stateDir = tmpDir("voice-art-read-state-");
		const sessionRoot = tmpDir("voice-art-read-session-");
		const source = path.join(sessionRoot, "NOTES.md");
		writeFileSync(source, "# original\n");
		const store = new ArtifactSnapshotStore(stateDir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: source });
		expect(record.status).toBe("ready");

		// The worktree moves on. The room's copy does not — that is the entire point of a snapshot,
		// and a viewer that re-read the source would show evidence that never existed.
		writeFileSync(source, "# rewritten by a later turn\n");
		const read = await store.read("room-1", record.id);
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.content).toBe("# original\n");
	});

	test("an unknown id in this channel is not-found, never another channel's file", async () => {
		const stateDir = tmpDir("voice-art-read-state-");
		const store = new ArtifactSnapshotStore(stateDir);
		const read = await store.read("room-1", "art-nope");
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.reason).toBe("not-found");
	});

	test("a failed row is not-ready and carries its own reason back", async () => {
		const stateDir = tmpDir("voice-art-read-state-");
		const store = new ArtifactSnapshotStore(stateDir);
		const record = store.recordFailed({ channelId: "room-1", callId: "call-1", sessionRoot: "/nope", sourcePath: "/nope/x.md" }, "journal reported artifact status: failed");
		const read = await store.read("room-1", record.id);
		expect(read.ok).toBe(false);
		if (!read.ok && read.reason !== "not-found") {
			expect(read.reason).toBe("not-ready");
			expect(read.record.error).toContain("failed");
		}
	});

	test("a ready row whose snapshot file has vanished is MISSING, not an empty document", async () => {
		const stateDir = tmpDir("voice-art-read-state-");
		const sessionRoot = tmpDir("voice-art-read-session-");
		const source = path.join(sessionRoot, "NOTES.md");
		writeFileSync(source, "# kept\n");
		const store = new ArtifactSnapshotStore(stateDir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: source });
		rmSync(record.snapshotPath!, { force: true });

		const read = await store.read("room-1", record.id);
		expect(read.ok).toBe(false);
		// An evidence viewer that renders "" for a lost snapshot is worse than one that reports the
		// loss — this is the assertion that keeps that from regressing.
		if (!read.ok && read.reason !== "not-found") {
			expect(read.reason).toBe("missing");
			expect(read.detail).toContain(record.snapshotPath!);
		}
	});

	test("an oversized snapshot is refused with its true size rather than truncated", async () => {
		const stateDir = tmpDir("voice-art-read-state-");
		const sessionRoot = tmpDir("voice-art-read-session-");
		const source = path.join(sessionRoot, "BIG.md");
		writeFileSync(source, "x".repeat(4096));
		const store = new ArtifactSnapshotStore(stateDir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: source });

		const read = await store.read("room-1", record.id, 1024);
		expect(read.ok).toBe(false);
		if (!read.ok && read.reason !== "not-found") {
			expect(read.reason).toBe("too-large");
			expect(read.detail).toContain("4096 bytes");
		}
		// The default cap is generous enough that a normal document never hits this path.
		expect(ARTIFACT_VIEW_MAX_BYTES).toBeGreaterThan(100_000);
		const withinDefault = await store.read("room-1", record.id);
		expect(withinDefault.ok).toBe(true);
	});
});

// -------------------------------------------------------------------------------------------------
// The visible mute relay
// -------------------------------------------------------------------------------------------------

/** A bridge that records EVERY control frame, so the mute tests can assert how many toggles were
 *  actually sent — the whole point of `setMuted` is that a repeated request sends none. */
function startRecordingBridge(sessionId: string) {
	const frames: Array<Record<string, unknown>> = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("ws only", { status: 426 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify({ v: 1, sessionId, seq: 0, type: "hello", canResolve: true }));
			},
			message(_ws, message) {
				frames.push(JSON.parse(typeof message === "string" ? message : message.toString()) as Record<string, unknown>);
			},
		},
	});
	cleanups.push(() => server.stop(true));
	return { frames, port: server.port, url: `ws://127.0.0.1:${server.port}` };
}

class OneCallBroker implements BrokerClient {
	readonly calls = new Map<string, BrokerCallView>();
	constructor(
		private readonly journalDir: string,
		private readonly bridgeUrl: string,
		private readonly bridgePort: number,
	) {}
	async createCall(): Promise<BrokerCallCreated> {
		const callId = "call-mute-1";
		const journalPath = path.join(this.journalDir, `${callId}.jsonl`);
		writeFileSync(journalPath, "");
		const view: BrokerCallCreated = { callId, port: this.bridgePort, bridgeUrl: this.bridgeUrl, journalPath, startedAt: Date.now(), exit: null, controlToken: "tok-1" };
		this.calls.set(callId, { ...view });
		return view;
	}
	async endCall(callId: string): Promise<void> {
		const call = this.calls.get(callId);
		if (call) call.exit = 0;
	}
	async listCalls(): Promise<BrokerCallView[]> {
		return [...this.calls.values()];
	}
}

function toggleCount(frames: Array<Record<string, unknown>>): number {
	return frames.filter((frame) => frame.action === "toggleMute").length;
}

async function liveCoordinator() {
	const stateDir = tmpDir("voice-mute-state-");
	const journalDir = tmpDir("voice-mute-journal-");
	const bridge = startRecordingBridge("mute-session");
	const broker = new OneCallBroker(journalDir, bridge.url, bridge.port);
	const cards: EmitCardInput[] = [];
	const coordinator = new VoiceCallCoordinator({
		stateDir,
		broker,
		emitCard: async (input) => {
			cards.push(input);
		},
		journalPollIntervalMs: 10_000,
		livenessProbeIntervalMs: 10_000,
	});
	cleanups.push(() => coordinator.stop());
	const started = await coordinator.startCall("room-1", { ownerActorId: "web:lars" });
	expect(started.ok).toBe(true);
	await waitFor(() => coordinator.state("room-1")?.state === "live");
	return { coordinator, bridge, cards };
}

describe("VoiceCallCoordinator#setMuted", () => {
	test("a live call mutes, and the state view reports what was asked", async () => {
		const { coordinator, bridge } = await liveCoordinator();
		expect(coordinator.state("room-1")?.micMuted).toBe(false);
		expect(coordinator.state("room-1")?.controlsAvailable).toBe(true);

		const muted = await coordinator.setMuted("room-1", true, true);
		expect(muted).toEqual({ ok: true, value: { muted: true } });
		expect(coordinator.state("room-1")?.micMuted).toBe(true);
		await waitFor(() => toggleCount(bridge.frames) === 1);
	});

	test("a repeated identical request sends NO second toggle", async () => {
		const { coordinator, bridge } = await liveCoordinator();
		await coordinator.setMuted("room-1", true, true);
		await waitFor(() => toggleCount(bridge.frames) === 1);

		// The wire control is a toggle. A second mute must not un-mute the mic the operator just
		// muted — that is the whole reason this layer is a SET.
		await coordinator.setMuted("room-1", true, true);
		await coordinator.setMuted("room-1", true, true);
		await new Promise((r) => setTimeout(r, 40));
		expect(toggleCount(bridge.frames)).toBe(1);
		expect(coordinator.state("room-1")?.micMuted).toBe(true);

		await coordinator.setMuted("room-1", true, false);
		await waitFor(() => toggleCount(bridge.frames) === 2);
		expect(coordinator.state("room-1")?.micMuted).toBe(false);
	});

	test("an unauthorized caller is refused before any frame is sent", async () => {
		const { coordinator, bridge } = await liveCoordinator();
		expect(await coordinator.setMuted("room-1", false, true)).toEqual({ ok: false, reason: "forbidden" });
		await new Promise((r) => setTimeout(r, 40));
		expect(toggleCount(bridge.frames)).toBe(0);
	});

	test("a channel with no call refuses honestly", async () => {
		const { coordinator } = await liveCoordinator();
		expect(await coordinator.setMuted("room-other", true, true)).toEqual({ ok: false, reason: "no-active-call" });
	});

	test("ending the call clears the mute rather than claiming a dead session is muted", async () => {
		const { coordinator } = await liveCoordinator();
		await coordinator.setMuted("room-1", true, true);
		expect(coordinator.state("room-1")?.micMuted).toBe(true);

		await coordinator.endCall("room-1", true);
		expect(coordinator.state("room-1")?.state).toBe("ended");
		expect(coordinator.state("room-1")?.micMuted).toBe(false);
		expect(coordinator.state("room-1")?.controlsAvailable).toBe(false);
		// And an ended call cannot be muted at all.
		expect(await coordinator.setMuted("room-1", true, true)).toEqual({ ok: false, reason: "no-active-call" });
	});
});
