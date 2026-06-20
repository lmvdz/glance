/**
 * Federation coordinator — live relay behavior over real WebSockets.
 *
 * No real timers: readiness is driven by awaiting the actual open/message
 * events (the bun runner supplies the overall timeout). Each test starts its
 * own coordinator on port 0 and tears everything down in afterEach.
 */

import { afterEach, expect, test } from "bun:test";
import { runCoordinator } from "../src/coordinator.ts";
import type { CoordinatorHandle } from "../src/coordinator.ts";

let handle: CoordinatorHandle | undefined;
const opened: WebSocket[] = [];

function connect(url: string): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(url);
	opened.push(ws);
	ws.onopen = (): void => resolve(ws);
	ws.onerror = (): void => reject(new Error(`failed to connect to ${url}`));
	return promise;
}

afterEach(() => {
	for (const ws of opened.splice(0)) {
		try {
			ws.close();
		} catch {
			// swallow: closing an already-closed socket during cleanup may throw
		}
	}
	handle?.stop();
	handle = undefined;
});

test("relays a frame to other peers but not the sender", async () => {
	handle = runCoordinator({ port: 0 });

	const client1 = await connect(handle.url);
	const client2 = await connect(handle.url);

	// client2 resolves with the first frame it receives, parsed back to an object.
	const received = Promise.withResolvers<unknown>();
	client2.onmessage = (event: MessageEvent): void => received.resolve(JSON.parse(String(event.data)));

	// The sender must never see its own frame echoed back.
	const selfEcho: unknown[] = [];
	client1.onmessage = (event: MessageEvent): void => selfEcho.push(event.data);

	const payload = { kind: "presence", n: 1 };
	client1.send(JSON.stringify(payload));

	expect(await received.promise).toEqual(payload);
	expect(selfEcho).toHaveLength(0);
});

test("a plain GET returns 200", async () => {
	handle = runCoordinator({ port: 0 });
	const res = await fetch(handle.url.replace("ws://", "http://"));
	expect(res.status).toBe(200);
});
