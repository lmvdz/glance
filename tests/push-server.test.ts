/**
 * Integration: a manager status event flows through the server and fires a push
 * (broadcast → maybePushAlert → escalationPayload → PushService dispatch).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PushService, type PushSend } from "../src/push.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { AgentDTO, AgentStatus } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function agent(status: AgentStatus, over: Partial<AgentDTO> = {}): AgentDTO {
	return { id: "x1", name: "alpha", status, kind: "omp-operator", repo: "/r", worktree: "/w", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

test("a transition into input drives a real encrypted push through the server", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushint-"));
	const calls: Array<{ endpoint: string; enc: string; len: number }> = [];
	let resolveSend: () => void = () => {};
	const sent = new Promise<void>((r) => {
		resolveSend = r;
	});
	const send: PushSend = async (endpoint, headers, body) => {
		calls.push({ endpoint, enc: headers["content-encoding"], len: body.length });
		resolveSend();
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();

	// a browser-shaped subscription so encryption has a real UA public key
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/device", keys: { p256dh, auth } });

	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	// seed the roster (no alert), then transition the agent into input
	mgr.emit("event", { type: "roster", agents: [agent("idle")] });
	mgr.emit("event", { type: "agent", agent: agent("input", { pending: [{ id: "p", source: "ui", kind: "select", title: "approve?", createdAt: 0 }] }) });

	await sent; // resolves when the push is dispatched — no polling
	expect(calls).toHaveLength(1);
	expect(calls[0].endpoint).toBe("https://push.example.com/device");
	expect(calls[0].enc).toBe("aes128gcm");
	expect(calls[0].len).toBeGreaterThan(80);
});

test("seeding + calm transitions do not push", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pushint2-"));
	let count = 0;
	const send: PushSend = async () => {
		count++;
		return { status: 201 };
	};
	const push = new PushService(dir, { send });
	await push.init();
	const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))).toString("base64url");
	await push.subscribe({ endpoint: "https://push.example.com/d", keys: { p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" } });
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, push });
	server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	mgr.emit("event", { type: "roster", agents: [agent("working")] }); // seed
	mgr.emit("event", { type: "agent", agent: agent("idle") }); // working→idle, calm
	// give any erroneous dispatch a chance to run before asserting
	await mgr.stop();
	expect(count).toBe(0);
});
