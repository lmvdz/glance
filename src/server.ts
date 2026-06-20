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
import { worktreeDiff, worktreeTree } from "./explore.ts";
import { listPlaneIssues } from "./plane.ts";
import { all, claim, release, who } from "./presence.ts";
import { landAgent } from "./land.ts";
import { gitState, pullLatest, reexecDaemon } from "./upgrade.ts";
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
	private presenceTimer?: Timer;
	private presenceDebounce?: Timer;
	/** agentId → repo it's claimed under, so we can release the claim on removal. */
	private readonly claimed = new Map<string, string>();

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
				if (url.pathname === "/api/projects") return Response.json(manager.projects());
				if (url.pathname === "/api/info") return Response.json({ cwd: process.cwd() });
				if (url.pathname === "/api/health") return Response.json({ ok: true, agents: manager.list().length, projects: manager.projects().length, uptimeSec: Math.round(process.uptime()) });
				if (url.pathname === "/api/presence") {
					const repo = url.searchParams.get("repo");
					return Response.json(repo ? await who(repo) : await all());
				}
				const mt = url.pathname.match(/^\/api\/agents\/([^/]+)\/transcript$/);
				if (mt) return Response.json(manager.getTranscript(decodeURIComponent(mt[1])));
				const msub = url.pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
				if (msub) return Response.json(manager.subagents(decodeURIComponent(msub[1])));
				const mdiff = url.pathname.match(/^\/api\/agents\/([^/]+)\/(diff|tree)$/);
				if (mdiff) {
					const dto = manager.getAgent(decodeURIComponent(mdiff[1]));
					if (!dto) return new Response("no such agent", { status: 404 });
					return Response.json(mdiff[2] === "diff" ? await worktreeDiff(dto.worktree) : await worktreeTree(dto.worktree));
				}
				const mland = url.pathname.match(/^\/api\/agents\/([^/]+)\/land$/);
				if (mland && req.method === "POST") {
					const dto = manager.getAgent(decodeURIComponent(mland[1]));
					if (!dto) return new Response("no such agent", { status: 404 });
					let message = `squad(${dto.name}): ${dto.issue?.name ?? "agent changes"}`;
					const body: unknown = await req.json().catch(() => null);
					if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message.trim()) {
						message = body.message.trim();
					}
					const result = await landAgent({ repo: dto.repo, worktree: dto.worktree, branch: dto.branch, message });
					return Response.json(result);
				}
				if (url.pathname === "/api/plane/issues") {
					const issues = await listPlaneIssues(url.searchParams.get("project") ?? "");
					if (issues === null) return new Response("plane not configured", { status: 501 });
					return Response.json(issues);
				}
				if (url.pathname === "/api/upgrade/status") return Response.json(await gitState(process.cwd()));
				if (url.pathname === "/api/upgrade" && req.method === "POST") {
					const repo = process.cwd();
					const pull = await pullLatest(repo);
					const after = await gitState(repo);
					// Detach agents (their hosts survive), free the port, and re-exec — the
					// relaunched daemon reconnects to the live agents with full context.
					setTimeout(() => {
						void (async () => {
							await manager.stop();
							this.server?.stop(true);
							reexecDaemon({ cmd: process.argv, cwd: repo });
							process.exit(0);
						})();
					}, 300);
					return Response.json({ ok: true, pull, git: after, restarting: true });
				}
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
					if (cmd.type === "commission") {
						const result = await manager.commission(cmd.spec, { install: true });
						return Response.json(result);
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
		void this.syncPresence();
		this.presenceTimer = setInterval(() => void this.syncPresence(), 25_000);
		this.presenceTimer.unref?.();
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
		if (e.type === "agent" || e.type === "removed" || e.type === "roster") this.schedulePresence();
	}

	private schedulePresence(): void {
		if (this.presenceDebounce) return;
		this.presenceDebounce = setTimeout(() => {
			this.presenceDebounce = undefined;
			void this.syncPresence();
		}, 1500);
		this.presenceDebounce.unref?.();
	}

	/** Mirror live squad agents into the shared presence registry so `who` + the command center see them next to raw omp sessions. */
	private async syncPresence(): Promise<void> {
		const liveIds = new Set<string>();
		for (const a of this.manager.list()) {
			liveIds.add(a.id);
			this.claimed.set(a.id, a.repo);
			await claim({ repo: a.repo, agent: a.name, branch: a.branch, task: a.issue?.name ?? a.activity, source: "squad", id: a.id });
		}
		for (const [id, repo] of this.claimed) {
			if (!liveIds.has(id)) {
				await release(id, repo);
				this.claimed.delete(id);
			}
		}
	}

	stop(): void {
		this.manager.off("event", this.onEvent);
		clearInterval(this.presenceTimer);
		clearTimeout(this.presenceDebounce);
		for (const [id, repo] of this.claimed) void release(id, repo);
		this.claimed.clear();
		this.server?.stop(true);
	}
}
