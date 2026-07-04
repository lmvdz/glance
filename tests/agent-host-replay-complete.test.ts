/**
 * End-to-end proof of the concern-2 replay-completion marker (#lifecycle-truth finding 2): agent-host.ts
 * writes an explicit `{"__sq":"replay_complete"}` frame LAST, right after replaying its whole ring, to
 * every newly-connected client. rpc-agent.ts surfaces it as a "replayComplete" event. This is the real
 * fix for SquadManager's reattach settle gate, which previously closed after a single `setImmediate` tick
 * — a heuristic that cannot account for a ring replay spanning many socket reads (up to 4000 lines).
 *
 * Drives the REAL agent-host + RpcAgent pair (a fake `omp` child, not a mocked AgentDriver) through a
 * detach + reconnect — the same "daemon restarts, host survives" sequence attachExisting relies on — and
 * asserts every replayed frame is observed strictly BEFORE the marker fires (stream order is preserved by
 * UDS regardless of how many reads the delivery spans).
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcAgent } from "../src/rpc-agent.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const RING_FRAME_COUNT = 25;

function fakeOmpChatty(): string {
	return `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "ready" }));
for (let i = 0; i < ${RING_FRAME_COUNT}; i++) {
	console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" + i } }));
}
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let f; try { f = JSON.parse(line); } catch { continue; }
		if (f.type === "get_state") console.log(JSON.stringify({ type: "response", id: f.id, success: true, command: "get_state", data: {} }));
	}
}
`;
}

test("a reattaching RpcAgent receives replayComplete strictly after every replayed ring frame", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-replay-complete-"));
	tmps.push(dir);
	const binPath = path.join(dir, "fake-omp-chatty.ts");
	await fs.writeFile(binPath, fakeOmpChatty());
	await fs.chmod(binPath, 0o755);

	const socket = path.join(dir, "agent.sock");
	const id = `replay-complete-${Date.now().toString(36)}`;

	// First connection: spawns the host + fake omp, which immediately emits its ready line + a burst of
	// frames into the host's ring.
	const first = new RpcAgent({ id, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
	await first.start(20_000);
	await Bun.sleep(200); // let the burst land in the host's ring before we detach
	first.detach(); // leave the host (and fake omp) alive — models a daemon restart, not an agent stop

	// Second connection (the "reattach"): the host is still alive, so start() takes the ATTACH path and
	// the host replays its whole ring — including the pre-existing burst — to this new client.
	const second = new RpcAgent({ id, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
	let markerSeen = false;
	const framesBeforeMarker: unknown[] = [];
	second.on("event", (frame: unknown) => {
		if (!markerSeen) framesBeforeMarker.push(frame);
	});
	const markerPromise = new Promise<void>((resolve) => second.once("replayComplete", () => resolve()));
	// Listeners are registered BEFORE start() — a host that delivers its whole reply in one socket read
	// can emit the marker synchronously inside start()'s own await chain (see armReplayCompleteWaiter's
	// comment in squad-manager.ts for why this ordering matters in production).
	await second.start(20_000);
	await markerPromise;
	markerSeen = true;

	// Every replayed message_update ring line landed as an "event" strictly before the marker fired.
	const replayedDeltas = framesBeforeMarker.filter(
		(f): f is { type: string; assistantMessageEvent?: { delta?: string } } => typeof f === "object" && f !== null && (f as { type?: string }).type === "message_update",
	);
	expect(replayedDeltas.length).toBeGreaterThanOrEqual(RING_FRAME_COUNT);

	await second.stop();
});
