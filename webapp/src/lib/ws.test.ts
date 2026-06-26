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
