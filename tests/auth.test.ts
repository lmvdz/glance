/**
 * auth — token persistence + the live HTTP/WS gate on a real bound server.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadOrCreateToken, requestToken, tokenOk } from "../src/auth.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

test("tokenOk is exact + rejects mismatches, lengths, and missing", () => {
	expect(tokenOk("hunter2", "hunter2")).toBe(true);
	expect(tokenOk("hunter2", "hunter3")).toBe(false);
	expect(tokenOk("short", "longer-token")).toBe(false); // length mismatch short-circuits
	expect(tokenOk(undefined, "x")).toBe(false);
	expect(tokenOk("", "x")).toBe(false);
});

test("requestToken reads Bearer header then WS subprotocol", () => {
	const hdr = new Request("http://x/api/agents", { headers: { authorization: "Bearer abc" } });
	expect(requestToken(hdr)).toBe("abc");
	const sub = new Request("http://x/ws", { headers: { "sec-websocket-protocol": "ompsq-token, def" } });
	expect(requestToken(sub)).toBe("def");
	expect(requestToken(new Request("http://x/api/agents"))).toBeUndefined();
});

test("loadOrCreateToken persists a 0600 token and is idempotent", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const a = await loadOrCreateToken(dir);
	expect(a.length).toBeGreaterThan(20);
	const stat = await fs.stat(path.join(dir, "access-token"));
	expect(stat.mode & 0o777).toBe(0o600);
	const b = await loadOrCreateToken(dir);
	expect(b).toBe(a); // same token on second read
});

test("a tokened server gates /api + WS but serves the shell publicly", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authsrv-"));
	const token = "s3cret-token-value";
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	// public shell — no token needed
	expect((await fetch(`${url}/`)).status).toBe(200);

	// /api without a token → 401
	expect((await fetch(`${url}/api/agents`)).status).toBe(401);
	expect((await fetch(`${url}/api/auth/check`)).status).toBe(401);

	// with the token (Bearer header) → 200; missing or wrong token → 401
	expect((await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
	expect((await fetch(`${url}/api/auth/check`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
	expect((await fetch(`${url}/api/agents`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);

	// WS handshake: opens with the token, rejected without
	const wsUrl = url.replace("http", "ws");
	const opened = await new Promise<boolean>((res) => {
		const ws = new WebSocket(`${wsUrl}/ws`, ["ompsq-token", token]);
		ws.onopen = () => {
			ws.close();
			res(true);
		};
		ws.onerror = () => res(false);
	});
	expect(opened).toBe(true);

	const blocked = await new Promise<boolean>((res) => {
		const ws = new WebSocket(`${wsUrl}/ws`);
		ws.onopen = () => res(true);
		ws.onerror = () => res(false);
		ws.onclose = () => res(false);
	});
	expect(blocked).toBe(false);
});

test("a tokenless server stays open (unit-test mode)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noauth-"));
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0 });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	expect((await fetch(`${url}/api/agents`)).status).toBe(200);
});
