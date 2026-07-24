import type { ClientCommand, SquadEvent } from "./dto";
import { captureToken, token } from "./api";

export interface SquadSocket {
  send(command: ClientCommand): void;
  close(): void;
}

export function connectSquad(options: {
  onEvent: (event: SquadEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  channelSince?: () => number;
}): SquadSocket {
  captureToken();
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnects = 0;
  let timer: number | undefined;
  const pending: ClientCommand[] = [];

  const flush = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (const command of pending.splice(0)) socket.send(JSON.stringify(command));
  };

  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const auth = token();
    const since = reconnects > 0 ? Math.max(0, Math.floor(options.channelSince?.() ?? 0)) : 0;
    const path = since > 0 ? `/ws?since=${encodeURIComponent(String(since))}` : '/ws';
    socket = auth ? new WebSocket(`${proto}://${location.host}${path}`, ["ompsq-token", auth]) : new WebSocket(`${proto}://${location.host}${path}`);
    socket.onopen = () => {
      reconnects = 0;
      options.onOpen?.();
      socket?.send(JSON.stringify({ type: "snapshot" }));
      flush();
    };
    socket.onmessage = (event) => {
      try {
        options.onEvent(JSON.parse(event.data as string) as SquadEvent);
      } catch {
        // Ignore malformed daemon frames.
      }
    };
    socket.onclose = () => {
      options.onClose?.();
      if (closed) return;
      const delay = Math.min(20_000, 500 * 2 ** Math.min(reconnects, 5)) + Math.random() * 400;
      reconnects++;
      timer = window.setTimeout(open, delay);
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return {
    send(command) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(command));
        return;
      }
      pending.push(command);
    },
    close() {
      closed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      socket?.close();
    },
  };
}
