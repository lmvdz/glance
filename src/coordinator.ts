/**
 * Federation coordinator — a dumb, protocol-agnostic WebSocket relay/hub.
 *
 * Every TailnetFederationBus (see federation.ts) connects here. The coordinator
 * never parses the frames it carries: each message received from one client is
 * rebroadcast verbatim to every OTHER connected client. That keeps the wire
 * protocol owned entirely by the buses — the hub is pure transport.
 *
 * The library is silent (no console output); coordinator-main.ts is the CLI.
 */

import type { Server, ServerWebSocket } from "bun";
import { requestToken, tokenOk } from "./auth.ts";

/** Live handle over a running coordinator: its address plus lifecycle control. */
export interface CoordinatorHandle {
	url: string;
	port: number;
	stop(): void;
	clients(): number;
}

export interface CoordinatorOptions {
	port?: number;
	hostname?: string;
	/**
	 * Pre-shared token gating the relay. When set, a client MUST present it
	 * (Authorization: Bearer, or the `ompsq-token` WS subprotocol) to upgrade;
	 * unauthenticated upgrades are rejected with 401. Unset ⇒ no auth (only safe
	 * on a loopback bind — coordinator-main refuses a non-loopback tokenless bind).
	 */
	token?: string;
}

interface SocketData {
	id: number;
}

/**
 * Start a relay on `opts.port` (default 7900; pass 0 for a free port). The
 * returned handle reflects the ACTUAL bound port and a locally-connectable url.
 */
export function runCoordinator(opts: CoordinatorOptions = {}): CoordinatorHandle {
	const sockets = new Set<ServerWebSocket<SocketData>>();
	let seq = 0;
	const token = opts.token;

	const server: Server<SocketData> = Bun.serve<SocketData>({
		port: opts.port ?? 7900,
		hostname: opts.hostname ?? "127.0.0.1",
		fetch(req, srv) {
			// Auth gate: a configured token must match before any upgrade. The plain
			// GET health body leaks nothing, so it stays open for liveness checks.
			const upgradeRequested = req.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (token !== undefined && upgradeRequested && !tokenOk(requestToken(req), token)) {
				return new Response("unauthorized", { status: 401 });
			}
			// Accept the upgrade on ANY path; echo the subprotocol sentinel so a
			// token-bearing client's negotiation succeeds (mirrors the daemon WS).
			const headers = token !== undefined ? { "Sec-WebSocket-Protocol": "ompsq-token" } : undefined;
			if (srv.upgrade(req, { data: { id: ++seq }, headers })) return undefined;
			return new Response("omp-squad coordinator", { status: 200 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
			},
			close(ws) {
				sockets.delete(ws);
			},
			message(ws, raw) {
				// Opaque fan-out: rebroadcast to everyone but the sender, never parsing.
				for (const sock of sockets) {
					if (sock === ws) continue;
					try {
						sock.send(raw);
					} catch {
						// swallow: one dead client must never break the fan-out to the rest
					}
				}
			},
		},
	});

	// 0.0.0.0 binds all interfaces but isn't a connectable address; an unset host
	// now binds loopback. Either way hand callers a loopback url to dial back in.
	const hostname = opts.hostname;
	const connectHost = hostname === undefined || hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
	const url = `ws://${connectHost}:${server.port}`;

	return {
		url,
		port: server.port ?? 0,
		stop() {
			server.stop(true);
		},
		clients() {
			return sockets.size;
		},
	};
}
