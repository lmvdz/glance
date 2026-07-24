import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { ChannelStore } from "../src/channels.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer, type SocketData } from "../src/server.ts";
import type { Actor, SquadEvent } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const actor = (userId: string): Actor => ({ id: `db:${userId}`, displayName: userId, origin: "local", role: "admin", orgId: "org-a" });

async function channelStore(name: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return new ChannelStore(dir, new FileStore(dir), undefined, () => 1000);
}

test("private channels require positive membership rows for reads and search", async () => {
	const channels = await channelStore("channel-membership-");
	const privateChannel = await channels.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	expect(privateChannel.visibility).toBe("private");
	expect((await channels.listChannels(actor("alice"))).map((channel) => channel.id)).toContain("ops");
	expect((await channels.listChannels(actor("carol"))).map((channel) => channel.id)).not.toContain("ops");
	await expect(channels.entries("ops", 0, actor("carol"))).rejects.toThrow("channel forbidden");

	await channels.appendClient("ops", actor("alice"), { text: "private launch code" });
	expect(await channels.search("launch", 50, actor("carol"))).toEqual([]);

	await channels.setMember("ops", actor("alice"), { userId: "bob" }, true);
	expect((await channels.entries("ops", 0, actor("bob"))).map((entry) => entry.text)).toEqual(["private launch code"]);

	await channels.setMember("ops", actor("alice"), { userId: "bob" }, false);
	await expect(channels.entries("ops", 0, actor("bob"))).rejects.toThrow("channel forbidden");
	expect((await channels.memberUserIds("ops"))?.sort()).toEqual(["alice"]);
});

test("private channel fan-out sends zero wire frames to same-org non-members", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-fanout-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	await mgr.addChannelMember("ops", actor("alice"), { userId: "bob" });
	const entry = await mgr.appendChannelPost("ops", actor("alice"), { text: "members only" });
	const event: SquadEvent = { type: "channel-entry", channelId: "ops", entry };
	const frames: Record<string, string[]> = { alice: [], bob: [], carol: [] };
	const fakeSocket = (userId: string) => ({ data: { userId, orgId: "org-a", role: "admin", displayName: userId }, send: (frame: string) => frames[userId]!.push(frame) });
	const host = server as unknown as { clients: Set<{ data: SocketData; send(frame: string): void }>; deliverEvent(orgId: string | undefined, event: SquadEvent): Promise<void> };
	host.clients.add(fakeSocket("alice"));
	host.clients.add(fakeSocket("bob"));
	host.clients.add(fakeSocket("carol"));

	await host.deliverEvent(undefined, event);
	expect(frames.alice).toHaveLength(1);
	expect(frames.bob).toHaveLength(1);
	expect(frames.carol).toEqual([]);
});

test("typing events are wire-only, debounced per channel, and never persisted as channel entries", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-typing-"));
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "org-public" });
	await mgr.applyCommand({ type: "typing", channelId: "fleet", active: true });

	const frames: string[] = [];
	const source = { data: { id: 1, userId: "alice", orgId: "org-a", role: "admin", displayName: "Alice" }, send: () => {} };
	const peer = { data: { id: 2, userId: "bob", orgId: "org-a", role: "admin", displayName: "Bob" }, send: (frame: string) => frames.push(frame) };
	const host = server as unknown as {
		clients: Set<{ data: SocketData; send(frame: string): void }>;
		emitTyping(source: { data: SocketData; send(frame: string): void }, manager: SquadManager, channelId: string, active: boolean): Promise<void>;
	};
	host.clients.add(source);
	host.clients.add(peer);

	await host.emitTyping(source, mgr, "fleet", true);
	await host.emitTyping(source, mgr, "fleet", true);
	await host.emitTyping(source, mgr, "ops", true);
	await host.emitTyping(source, mgr, "fleet", false);

	expect(frames.map((frame) => JSON.parse(frame))).toEqual([
		{ type: "typing", channelId: "fleet", userId: "db:alice", displayName: "Alice", active: true, at: expect.any(Number) },
		{ type: "typing", channelId: "ops", userId: "db:alice", displayName: "Alice", active: true, at: expect.any(Number) },
		{ type: "typing", channelId: "fleet", userId: "db:alice", displayName: "Alice", active: false, at: expect.any(Number) },
	]);
	expect(await mgr.channelEntries("fleet")).toEqual([]);
	expect(await mgr.channelEntries("ops")).toEqual([]);
});


test("HTTP private channel reads 403 and search is empty for non-member callers", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-http-leak-"));
	const token = "channel-http-token";
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	await mgr.createChannel(actor("alice"), { id: "ops", name: "#ops", visibility: "private" });
	await mgr.appendChannelPost("ops", actor("alice"), { text: "hidden launch needle" });
	const headers = { authorization: `Bearer ${token}` };

	const read = await fetch(`${url}/api/channels/ops/entries`, { headers });
	expect(read.status).toBe(403);
	const search = await fetch(`${url}/api/channels/search?q=hidden%20launch`, { headers });
	expect(search.status).toBe(200);
	expect(await search.json()).toEqual({ results: [] });
});
