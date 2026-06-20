/**
 * SquadServer — HTTP + WebSocket bridge over a SquadManager.
 *
 * Wire protocol (JSON):
 *   server → client : SquadEvent (plus a `roster` snapshot on connect)
 *   client → server : ClientCommand
 *
 * The web dashboard and any remote viewer are just WS clients. (Federation
 * peers are a separate transport — see federation.ts — not this local server.)
 */

import * as path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { ClientCommand, SquadEvent } from "./types.ts";
import type { SquadManager } from "./squad-manager.ts";

const INDEX_HTML = path.join(import.meta.dir, "web", "index.html");

interface SocketData {
	id: number;
}

export interface SquadServerOptions {
	port?: number;
	hostname?: string;
}

export class SquadServer {
	private readonly manager: SquadManager;
	private readonly clients = new Set<ServerWebSocket<SocketData>>();
	private server?: Server<SocketData>;
	private readonly opts: SquadServerOptions;
	private sockSeq = 0;
	private readonly onEvent: (e: SquadEvent) => void;

	constructor(manager: SquadManager, opts: SquadServerOptions = {}) {
		this.manager = manager;
		this.opts = opts;
		this.onEvent = (e: SquadEvent) => this.broadcast(e);
	}

	get url(): string {
		const host = this.opts.hostname ?? "127.0.0.1";
		return `http://${host}:${this.server?.port ?? this.opts.port ?? 0}`;
	}

	start(): string {
		const manager = this.manager;
		const clients = this.clients;
		const indexFile = Bun.file(INDEX_HTML);

		this.server = Bun.serve<SocketData>({
			port: this.opts.port ?? 7878,
			hostname: this.opts.hostname ?? "127.0.0.1",
			fetch: async (req, server) => {
				const url = new URL(req.url);
				if (url.pathname === "/ws") {
					if (server.upgrade(req, { data: { id: ++this.sockSeq } })) return undefined;
					return new Response("websocket upgrade failed", { status: 426 });
				}
				if (url.pathname === "/" || url.pathname === "/index.html") {
					return new Response(indexFile, { headers: { "content-type": "text/html; charset=utf-8" } });
				}
				if (url.pathname === "/api/agents") return Response.json(manager.list());
				if (url.pathname === "/api/info") return Response.json({ cwd: process.cwd() });
				const m = url.pathname.match(/^\/api\/agents\/([^/]+)\/transcript$/);
				if (m) return Response.json(manager.getTranscript(decodeURIComponent(m[1])));
				if (url.pathname === "/api/command" && req.method === "POST") {
					let cmd: ClientCommand;
					try {
						cmd = (await req.json()) as ClientCommand;
					} catch {
						return new Response("bad json", { status: 400 });
					}
					if (cmd.type === "create") {
						const dto = await manager.create(cmd.options);
						return Response.json(dto);
					}
					await manager.applyCommand(cmd);
					return Response.json({ ok: true });
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open: (ws) => {
					clients.add(ws);
					ws.send(JSON.stringify({ type: "roster", agents: manager.list() } satisfies SquadEvent));
				},
				close: (ws) => {
					clients.delete(ws);
				},
				message: (ws, raw) => {
					let cmd: ClientCommand;
					try {
						cmd = JSON.parse(typeof raw === "string" ? raw : raw.toString());
					} catch {
						return;
					}
					// Transcript replay is unicast to the requesting socket.
					if (cmd.type === "subscribe") {
						for (const entry of manager.getTranscript(cmd.id)) {
							ws.send(JSON.stringify({ type: "transcript", id: cmd.id, entry } satisfies SquadEvent));
						}
						return;
					}
					// All surfaces today are local; federation peers carry their own actor.
					void manager.applyCommand(cmd);
				},
			},
		});

		manager.on("event", this.onEvent);
		return this.url;
	}

	private broadcast(e: SquadEvent): void {
		const s = JSON.stringify(e);
		for (const ws of this.clients) {
			try {
				ws.send(s);
			} catch {
				/* dropped client */
			}
		}
	}

	stop(): void {
		this.manager.off("event", this.onEvent);
		this.server?.stop(true);
	}
}
