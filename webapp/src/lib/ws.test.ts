import { afterEach, expect, test } from "bun:test";
import { connectSquad } from "./ws";

const originalWebSocket = globalThis.WebSocket;
const originalLocation = globalThis.location;

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
  Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
});

test("connectSquad queues commands until the websocket opens", () => {
  const sent: string[] = [];
  let instance: { readyState: number; onopen?: () => void; send: (value: string) => void; close: () => void } | undefined;

  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;

    constructor() {
      instance = this;
    }

    send(value: string) {
      sent.push(value);
    }

    close() {}
  }

  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });

  const socket = connectSquad({ onEvent: () => {} });
  socket.send({ type: "subscribe", id: "chat-1" });
  expect(sent).toEqual([]);

  instance!.readyState = FakeWebSocket.OPEN;
  instance!.onopen?.();
  expect(sent.map((item) => JSON.parse(item))).toEqual([{ type: "snapshot" }, { type: "subscribe", id: "chat-1" }]);
});

test("connectSquad reconnects with the latest channel seq so channel-entry frames resync without gaps or dupes", () => {
  const urls: string[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalRandom = Math.random;
  const originalWindow = globalThis.window;
  let latestSeq = 7;
  let instance: { readyState: number; onopen?: () => void; onclose?: () => void; send: (value: string) => void; close: () => void } | undefined;

  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;

    constructor(url: string) {
      urls.push(url);
      instance = this;
    }

    send() {}
    close() {}
  }

  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: (callback: () => void) => { callback(); return 1; } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  Math.random = () => 0;

  try {
    connectSquad({ onEvent: () => {}, channelSince: () => latestSeq } as never);
    expect(urls).toEqual(["ws://localhost/ws"]);

    latestSeq = 42;
    instance!.onclose?.();

    expect(urls).toEqual(["ws://localhost/ws", "ws://localhost/ws?since=42"]);
  } finally {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout });
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Math.random = originalRandom;
  }
});
