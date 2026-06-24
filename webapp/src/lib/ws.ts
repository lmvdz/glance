import type { ClientCommand, SquadEvent } from "./dto";

const TOKEN_KEY = "ompsq_token";

/** Capture ?token=... into localStorage (mirrors src/web/index.html), strip from the URL. */
function captureToken(): void {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get("token");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      u.searchParams.delete("token");
      history.replaceState(null, "", u.toString());
    }
  } catch {
    /* non-browser / blocked storage */
  }
}

export function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Authenticated fetch — adds the Bearer header the daemon expects in file mode. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const t = token();
  const headers = new Headers(init?.headers);
  if (t) headers.set("Authorization", "Bearer " + t);
  return fetch(path, { ...init, headers });
}

export interface SquadSocket {
  send(cmd: ClientCommand): void;
  close(): void;
}

/**
 * Connect to the SquadServer WS at /ws with exponential-backoff reconnect,
 * mirroring src/web/index.html. File-mode auth rides the `ompsq-token`
 * subprotocol (browsers can't set WS request headers). Sends a `snapshot`
 * request on open so we get a full roster replay.
 *
 * ponytail: hand-rolled backoff copied from the live client — no reconnect lib.
 */
export function connectSquad(opts: {
  onEvent: (ev: SquadEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}): SquadSocket {
  captureToken();
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnects = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    const t = token();
    ws = t ? new WebSocket(url, ["ompsq-token", t]) : new WebSocket(url);
    ws.onopen = () => {
      reconnects = 0;
      opts.onOpen?.();
      ws?.send(JSON.stringify({ type: "snapshot" }));
    };
    ws.onmessage = (e) => {
      try {
        opts.onEvent(JSON.parse(e.data as string) as SquadEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      opts.onClose?.();
      if (closed) return;
      const delay = Math.min(20000, 500 * 2 ** Math.min(reconnects, 5)) + Math.random() * 400;
      reconnects++;
      timer = setTimeout(open, delay);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
    };
  }
  open();

  return {
    send(cmd) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
